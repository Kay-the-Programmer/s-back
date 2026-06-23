import express from 'express';
import crypto from 'crypto';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { storeInitService } from '../services/store-init.service';
import { subscriptionService, SUBSCRIPTION_PLANS, getEffectivePlan } from '../services/subscription.service';
import { sendStoreOTPVerificationEmail } from '../services/email.service';
import { invalidateUserCache } from '../middleware/auth.middleware';
import { setEnabledModules } from '../services/entitlements.service';
import { TRIAL_MODULES, TRIAL_DAYS } from '../services/plan-modules';

export const checkStoreName = async (req: express.Request, res: express.Response) => {
  try {
    const { name } = req.query;
    if (!name || String(name).trim().length < 2) {
      return res.status(200).json({ exists: false });
    }
    const result = await db.query('SELECT id FROM stores WHERE LOWER(trim(name)) = LOWER($1) LIMIT 1', [String(name).trim()]);
    return res.status(200).json({ exists: result.rows.length > 0 });
  } catch (error) {
    console.error('Error checking store name:', error);
    return res.status(500).json({ message: 'Error checking store name' });
  }
};

/**
 * Sends a verification code to the current user's email WITHOUT creating a store.
 * This lets us verify ownership of the email before any store row is persisted, so an
 * abandoned setup never leaves an unverified store sitting on the chosen name.
 */
export const requestStoreSetupOtp = async (req: express.Request, res: express.Response) => {
  try {
    const user = req.user!;
    const { name } = req.body || {};

    if (!user || !user.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ message: 'Store name is required' });
    }
    if (!user.email) {
      return res.status(400).json({ message: 'Your account has no email on file to send a verification code to.' });
    }

    // Re-check name availability at request time for a fast, friendly failure.
    const existing = await db.query('SELECT id FROM stores WHERE LOWER(trim(name)) = LOWER($1) LIMIT 1', [String(name).trim()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'A store with this name already exists. Please choose a different name.' });
    }

    const otp = crypto.randomInt(100000, 999999).toString();
    const expires = new Date();
    expires.setHours(expires.getHours() + 1); // short-lived; the whole setup happens in one sitting

    await db.query(
      'UPDATE users SET store_setup_otp = $1, store_setup_otp_expires = $2, last_verification_sent_at = NOW() WHERE id = $3',
      [otp, expires, user.id]
    );

    // Fire and forget OTP email
    sendStoreOTPVerificationEmail(user.email, String(name).trim(), otp).catch(console.error);

    // Mask the email so the UI can show "code sent to j***@example.com" without exposing it fully.
    const [local, domain] = String(user.email).split('@');
    const maskedEmail = domain ? `${local.slice(0, 1)}***@${domain}` : undefined;

    return res.status(200).json({ message: 'Verification code sent', email: maskedEmail });
  } catch (error) {
    console.error('Error requesting store setup OTP:', error);
    return res.status(500).json({ message: 'Error sending verification code' });
  }
};

export const registerStore = async (req: express.Request, res: express.Response) => {

  try {
    const user = req.user!;
    const { name, phone, address, planId = 'plan_basic', paymentMethod = 'LENCO', otp } = req.body || {};

    if (!user || !user.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ message: 'Store name is required' });
    }

    // If an OTP is supplied, this is the deferred-creation setup flow: the email is verified
    // up front and the store is created here, atomically, in a single request. We validate the
    // code BEFORE writing anything. (When no OTP is supplied we keep the legacy behaviour so the
    // public self-service signup in Register.tsx is unaffected.)
    const hasOtp = otp !== undefined && otp !== null && String(otp).trim() !== '';
    if (hasOtp) {
      const urow = (await db.query(
        'SELECT store_setup_otp, store_setup_otp_expires FROM users WHERE id = $1',
        [user.id]
      )).rows[0];
      if (!urow || !urow.store_setup_otp) {
        return res.status(400).json({ message: 'No verification in progress. Please request a new code.' });
      }
      if (urow.store_setup_otp !== String(otp).trim()) {
        return res.status(400).json({ message: 'Invalid verification code.' });
      }
      if (new Date(urow.store_setup_otp_expires) < new Date()) {
        return res.status(400).json({ message: 'Verification code has expired. Please request a new one.' });
      }
    }

    // 1. Check for uniqueness
    const existing = await db.query('SELECT id FROM stores WHERE LOWER(trim(name)) = LOWER($1) LIMIT 1', [String(name).trim()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'A store with this name already exists. Please choose a different name.' });
    }

    const storeId = generateId('store');
    const plan = (await getEffectivePlan(planId)) || SUBSCRIPTION_PLANS[0];

    await db.query('BEGIN');
    try {
      // 2. Insert store with selected plan and 'trial' status by default until payment.
      // When the email was verified up front (hasOtp), the store is created already verified and
      // we skip the legacy "store OTP" email. Otherwise we keep the old verify-after-create flow.
      const subscriptionStatus = plan.price === 0 ? 'active' : 'trial';
      // Free intro trial of premium add-ons: paid plans start as a time-boxed
      // trial so the user can taste premium before paying. Free plans (price 0)
      // get core only and never expire (NULL ends_at).
      const trialEndsAt = subscriptionStatus === 'trial'
        ? (() => { const e = new Date(); e.setDate(e.getDate() + TRIAL_DAYS); return e; })()
        : null;
      const storeOtp = hasOtp ? null : crypto.randomInt(100000, 999999).toString();
      const storeOtpExpires = hasOtp ? null : (() => { const e = new Date(); e.setHours(e.getHours() + 24); return e; })();

      await db.query(
        "INSERT INTO stores (id, name, status, subscription_status, subscription_plan, subscription_ends_at, is_verified, verification_token, verification_token_expires) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8)",
        [storeId, String(name).trim(), subscriptionStatus, planId, trialEndsAt, hasOtp, storeOtp, storeOtpExpires]
      );

      // Fire and forget OTP email (legacy verify-after-create path only)
      if (!hasOtp && user.email) {
        sendStoreOTPVerificationEmail(user.email, String(name).trim(), storeOtp!).catch(console.error);
      }

      // 3. Make the registering user an admin for now (global role), set current store, and
      //    clear any pending setup OTP now that it has been consumed.
      await db.query(
        'UPDATE users SET role = $1, current_store_id = $2, store_setup_otp = NULL, store_setup_otp_expires = NULL WHERE id = $3',
        ['admin', storeId, user.id]
      );

      invalidateUserCache(user.id);

      // 4. Initialize the new store with defaults (creates the store_settings row)
      const businessTypes = req.body.businessTypes || [];
      await storeInitService.initializeNewStore(storeId, String(name).trim(), businessTypes, phone, address);

      // Grant the premium add-ons for the duration of the intro trial so the user
      // experiences the paid features. The lifecycle job revokes these at trial end
      // unless they pay (which re-grants the plan's modules).
      if (subscriptionStatus === 'trial') {
        try {
          await setEnabledModules(storeId, [...TRIAL_MODULES]);
        } catch (modErr) {
          console.error('Failed to grant trial modules:', modErr);
        }
      }

      await db.query('COMMIT');

      // 5. If it's a paid plan, we initiate payment immediately or return a redirect
      let paymentInfo = null;
      if (plan.price > 0) {
        try {
          paymentInfo = await subscriptionService.initiatePayment(storeId, planId, paymentMethod, phone);
        } catch (payErr) {
          console.error('Error initiating initial payment:', payErr);
          // We don't fail registration, but we tell the user they need to pay
        }
      }

      const store = (await db.query('SELECT id, name, subscription_status, subscription_plan, created_at FROM stores WHERE id = $1', [storeId])).rows[0];

      return res.status(201).json(toCamelCase({
        store,
        payment: paymentInfo
      }));

    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  } catch (error) {
    console.error('Error registering store:', error);
    return res.status(500).json({ message: 'Error registering store' });
  }
};

export const verifyStoreRegistration = async (req: express.Request, res: express.Response) => {
  try {
    const { storeId, otp } = req.body;
    if (!storeId || !otp) {
      return res.status(400).json({ message: 'Store ID and OTP are required' });
    }

    const storeRes = await db.query(
      'SELECT id, verification_token, verification_token_expires FROM stores WHERE id = $1',
      [storeId]
    );

    if (storeRes.rows.length === 0) {
      return res.status(404).json({ message: 'Store not found' });
    }

    const store = storeRes.rows[0];

    if (!store.verification_token) {
      return res.status(400).json({ message: 'Store is already verified or no OTP requested' });
    }

    if (store.verification_token !== String(otp).trim()) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    if (new Date(store.verification_token_expires) < new Date()) {
      return res.status(400).json({ message: 'OTP has expired' });
    }

    // Mark as verified
    await db.query(
      'UPDATE stores SET is_verified = TRUE, verification_token = NULL, verification_token_expires = NULL WHERE id = $1',
      [storeId]
    );

    return res.status(200).json({ message: 'Store successfully verified' });
  } catch (error) {
    console.error('Error verifying store OTP:', error);
    return res.status(500).json({ message: 'Error verifying store OTP' });
  }
};
