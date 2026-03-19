import express from 'express';
import crypto from 'crypto';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { storeInitService } from '../services/store-init.service';
import { subscriptionService, SUBSCRIPTION_PLANS } from '../services/subscription.service';
import { sendStoreOTPVerificationEmail } from '../services/email.service';
import { invalidateUserCache } from '../middleware/auth.middleware';

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

export const registerStore = async (req: express.Request, res: express.Response) => {

  try {
    const user = req.user!;
    const { name, phone, address, planId = 'plan_basic', paymentMethod = 'LENCO' } = req.body || {};

    if (!user || !user.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ message: 'Store name is required' });
    }

    // 1. Check for uniqueness
    const existing = await db.query('SELECT id FROM stores WHERE LOWER(trim(name)) = LOWER($1) LIMIT 1', [String(name).trim()]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ message: 'A store with this name already exists. Please choose a different name.' });
    }

    const storeId = generateId('store');
    const plan = subscriptionService.getPlanById(planId) || SUBSCRIPTION_PLANS[0];

    await db.query('BEGIN');
    try {
      // 2. Insert store with selected plan and 'trial' status by default until payment
      const subscriptionStatus = plan.price === 0 ? 'active' : 'trial';
      const otp = crypto.randomInt(100000, 999999).toString();
      const expires = new Date();
      expires.setHours(expires.getHours() + 24);

      await db.query(
        "INSERT INTO stores (id, name, status, subscription_status, subscription_plan, is_verified, verification_token, verification_token_expires) VALUES ($1, $2, 'active', $3, $4, false, $5, $6)",
        [storeId, String(name).trim(), subscriptionStatus, planId, otp, expires]
      );

      // Fire and forget OTP email
      if (user.email) {
        sendStoreOTPVerificationEmail(user.email, String(name).trim(), otp).catch(console.error);
      }

      // 3. Make the registering user an admin for now (global role) and set current store
      await db.query('UPDATE users SET role = $1, current_store_id = $2 WHERE id = $3', ['admin', storeId, user.id]);

      invalidateUserCache(user.id);

      // 4. Initialize the new store with defaults
      const businessTypes = req.body.businessTypes || [];
      await storeInitService.initializeNewStore(storeId, String(name).trim(), businessTypes, phone, address);

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
