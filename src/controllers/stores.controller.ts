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
import { NOT_CANCELLED, SALE_REVENUE } from '../utils/revenue';

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
    // Store registration is for business accounts. Customers and suppliers have
    // their own flows — without this guard they'd be silently promoted to admin.
    if (user.role === 'customer' || user.role === 'supplier') {
      return res.status(403).json({ message: 'This account type cannot register a store. Please sign up with a business account.' });
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
      // Store verification is about proving the owner's email. If the account
      // email is already verified (registration OTP or Google sign-in), the
      // store inherits it — no second OTP ceremony.
      const isVerifiedStore = hasOtp || !!user.isVerified;
      const storeOtp = isVerifiedStore ? null : crypto.randomInt(100000, 999999).toString();
      const storeOtpExpires = isVerifiedStore ? null : (() => { const e = new Date(); e.setHours(e.getHours() + 24); return e; })();

      await db.query(
        "INSERT INTO stores (id, name, status, subscription_status, subscription_plan, subscription_ends_at, is_verified, verification_token, verification_token_expires, owner_id) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7, $8, $9)",
        [storeId, String(name).trim(), subscriptionStatus, planId, trialEndsAt, isVerifiedStore, storeOtp, storeOtpExpires, user.id]
      );

      // Fire and forget OTP email (legacy verify-after-create path only)
      if (!isVerifiedStore && user.email) {
        sendStoreOTPVerificationEmail(user.email, String(name).trim(), storeOtp!).catch(console.error);
      }

      // 3. Make the registering user an admin of the new store (superadmin keeps
      //    the platform role — registering a store must never demote it), set
      //    current store, and clear any pending setup OTP now that it's consumed.
      const newRole = user.role === 'superadmin' ? 'superadmin' : 'admin';
      await db.query(
        'UPDATE users SET role = $1, current_store_id = $2, store_setup_otp = NULL, store_setup_otp_expires = NULL WHERE id = $3',
        [newRole, storeId, user.id]
      );

      invalidateUserCache(user.id);

      // 4. Initialize the new store with defaults (creates the store_settings row).
      // isWholesaleSupplier: supplier registration — the store opts into the
      // B2B wholesale marketplace from day one (same flag as the Online Store
      // app toggle, so it can be turned off later).
      const businessTypes = req.body.businessTypes || [];
      const isWholesaleSupplier = req.body.isWholesaleSupplier === true;
      await storeInitService.initializeNewStore(storeId, String(name).trim(), businessTypes, phone, address, isWholesaleSupplier);

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

      // 5. Paid plan + an actionable payment method → initiate payment now.
      // Otherwise the store simply starts its trial and pays in-app later —
      // initiating unconditionally used to create a dangling 'pending'
      // subscription_payments row for every self-service registration.
      let paymentInfo = null;
      if (plan.price > 0 && paymentMethod === 'mobile-money' && phone) {
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
  } catch (error: any) {
    // Unique-index race: two requests claimed the same name between the SELECT
    // check and the INSERT — surface it as the same friendly validation error.
    if (error?.code === '23505') {
      return res.status(400).json({ message: 'A store with this name already exists. Please choose a different name.' });
    }
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

// ── Multi-Store Manager ───────────────────────────────────────────────────────

/** Every business the current user owns (for the Multi-Store Manager). */
export const getMyStores = async (req: express.Request, res: express.Response) => {
  try {
    const userId = req.user!.id;
    const currentStoreId = req.user?.currentStoreId;
    const result = await db.query(
      `SELECT id, name, status, subscription_status, subscription_plan, subscription_ends_at, is_verified, created_at
       FROM stores WHERE owner_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    const stores = result.rows.map((s: any) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      subscriptionStatus: s.subscription_status,
      subscriptionPlan: s.subscription_plan,
      subscriptionEndsAt: s.subscription_ends_at,
      isVerified: s.is_verified,
      createdAt: s.created_at,
      isCurrent: s.id === currentStoreId,
    }));
    res.json(stores);
  } catch (error: any) {
    console.warn('[stores] my-stores failed:', error.message);
    res.json([]);
  }
};

/**
 * Portfolio summary for the Business Manager hub: per-store KPIs and a daily
 * revenue trend for every business the user owns, plus combined totals — in
 * one round trip. Window semantics: `days=1` = today (from midnight),
 * `days=7` = last 7 calendar days, etc.; the delta baseline (`prevRevenue`)
 * is the equal-length window immediately before.
 */
export const getMyStoresSummary = async (req: express.Request, res: express.Response) => {
  try {
    const userId = req.user!.id;
    const currentStoreId = req.user?.currentStoreId;
    const days = Math.min(Math.max(parseInt(String(req.query.days ?? '7'), 10) || 7, 1), 90);

    const storesRes = await db.query(
      `SELECT id, name, status, subscription_status, subscription_plan, subscription_ends_at, is_verified, created_at
       FROM stores WHERE owner_id = $1 ORDER BY created_at ASC`,
      [userId],
    );
    if (storesRes.rows.length === 0) {
      return res.json({ days, stores: [], totals: null });
    }
    const ids = storesRes.rows.map((r: any) => r.id);

    // Day-boundary windows: current = [startOfToday - (days-1)d, now], previous = the equal period before.
    const windowStart = new Date();
    windowStart.setHours(0, 0, 0, 0);
    windowStart.setDate(windowStart.getDate() - (days - 1));
    const prevStart = new Date(windowStart);
    prevStart.setDate(prevStart.getDate() - days);

    const [curSales, prevSales, trendRes, refundsRes, refundTrendRes, productsRes, customersRes, usersRes] = await Promise.all([
      db.query(
        // Same revenue definition as every other screen: ex-tax, net of the
        // order discount, cancelled sales excluded. This used SUM(total) —
        // tax-inclusive and refund-blind — so the portfolio read higher than
        // each store's own dashboard. Refunds are subtracted below, dated by
        // the RETURN, exactly as the dashboard does it.
        `SELECT s.store_id, COALESCE(SUM(${SALE_REVENUE}),0)::float AS revenue, COUNT(*)::int AS transactions
         FROM sales s
         WHERE s.store_id = ANY($1) AND s."timestamp" >= $2 AND ${NOT_CANCELLED}
         GROUP BY s.store_id`,
        [ids, windowStart],
      ),
      db.query(
        `SELECT s.store_id, COALESCE(SUM(${SALE_REVENUE}),0)::float AS revenue
         FROM sales s
         WHERE s.store_id = ANY($1) AND s."timestamp" >= $2 AND s."timestamp" < $3 AND ${NOT_CANCELLED}
         GROUP BY s.store_id`,
        [ids, prevStart, windowStart],
      ),
      db.query(
        `SELECT s.store_id, to_char(date_trunc('day', s."timestamp"), 'YYYY-MM-DD') AS day,
                COALESCE(SUM(${SALE_REVENUE}),0)::float AS revenue
         FROM sales s
         WHERE s.store_id = ANY($1) AND s."timestamp" >= $2 AND ${NOT_CANCELLED}
         GROUP BY 1, 2`,
        [ids, windowStart],
      ),
      // Refunds by store, dated by the return — subtracted from the windows
      // above so a refund reduces the period it happened in.
      db.query(
        `SELECT store_id,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE "timestamp" >= $2), 0)::float AS refunds,
                COALESCE(SUM(subtotal_amount) FILTER (WHERE "timestamp" >= $3 AND "timestamp" < $2), 0)::float AS prev_refunds
         FROM returns WHERE store_id = ANY($1) AND "timestamp" >= $3
         GROUP BY store_id`,
        [ids, windowStart, prevStart],
      ),
      db.query(
        `SELECT store_id, to_char(date_trunc('day', "timestamp"), 'YYYY-MM-DD') AS day,
                COALESCE(SUM(subtotal_amount),0)::float AS refunds
         FROM returns WHERE store_id = ANY($1) AND "timestamp" >= $2
         GROUP BY 1, 2`,
        [ids, windowStart],
      ),
      db.query(
        `SELECT store_id,
                COUNT(*) FILTER (WHERE status = 'active')::int AS products_count,
                COUNT(*) FILTER (WHERE status = 'active' AND stock <= COALESCE(reorder_point, 5))::int AS low_stock_count,
                COALESCE(SUM(stock * COALESCE(cost_price, 0)) FILTER (WHERE status = 'active'), 0)::float AS inventory_value,
                COALESCE(SUM(stock * COALESCE(price, 0)) FILTER (WHERE status = 'active'), 0)::float AS inventory_retail_value
         FROM products WHERE store_id = ANY($1) GROUP BY store_id`,
        [ids],
      ),
      db.query(
        `SELECT store_id, COUNT(*)::int AS customers_count FROM customers WHERE store_id = ANY($1) GROUP BY store_id`,
        [ids],
      ),
      db.query(
        `SELECT current_store_id AS store_id, COUNT(*)::int AS users_count FROM users WHERE current_store_id = ANY($1) GROUP BY 1`,
        [ids],
      ),
    ]);

    const byStore = <T extends { store_id: string }>(rows: T[]) => new Map(rows.map(r => [r.store_id, r]));
    const cur = byStore(curSales.rows);
    const prev = byStore(prevSales.rows);
    const refunds = byStore(refundsRes.rows);
    const prod = byStore(productsRes.rows);
    const cust = byStore(customersRes.rows);
    const usrs = byStore(usersRes.rows);

    // Revenue per store per day, with every day of the window present (0-filled).
    const dayKeys: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(windowStart);
      d.setDate(d.getDate() + i);
      dayKeys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    const trendMap = new Map<string, Map<string, number>>();
    for (const row of trendRes.rows as any[]) {
      if (!trendMap.has(row.store_id)) trendMap.set(row.store_id, new Map());
      trendMap.get(row.store_id)!.set(row.day, Number(row.revenue) || 0);
    }
    // A refund reduces the day it was given, not the day of the original sale.
    for (const row of refundTrendRes.rows as any[]) {
      if (!trendMap.has(row.store_id)) trendMap.set(row.store_id, new Map());
      const day = trendMap.get(row.store_id)!;
      day.set(row.day, (day.get(row.day) || 0) - (Number(row.refunds) || 0));
    }

    const stores = storesRes.rows.map((s: any) => {
      const c: any = cur.get(s.id) || {};
      const p: any = prev.get(s.id) || {};
      const pr: any = prod.get(s.id) || {};
      const cu: any = cust.get(s.id) || {};
      const us: any = usrs.get(s.id) || {};
      const tm = trendMap.get(s.id);
      return {
        id: s.id,
        name: s.name,
        status: s.status,
        subscriptionStatus: s.subscription_status,
        subscriptionPlan: s.subscription_plan,
        subscriptionEndsAt: s.subscription_ends_at,
        isVerified: s.is_verified,
        createdAt: s.created_at,
        isCurrent: s.id === currentStoreId,
        revenue: (Number(c.revenue) || 0) - (Number((refunds.get(s.id) as any)?.refunds) || 0),
        prevRevenue: (Number(p.revenue) || 0) - (Number((refunds.get(s.id) as any)?.prev_refunds) || 0),
        transactions: Number(c.transactions) || 0,
        productsCount: Number(pr.products_count) || 0,
        lowStockCount: Number(pr.low_stock_count) || 0,
        inventoryValue: Number(pr.inventory_value) || 0,
        inventoryRetailValue: Number(pr.inventory_retail_value) || 0,
        customersCount: Number(cu.customers_count) || 0,
        usersCount: Number(us.users_count) || 0,
        trend: dayKeys.map(day => ({ date: day, revenue: tm?.get(day) || 0 })),
      };
    });

    const totals = stores.reduce((t, s) => ({
      revenue: t.revenue + s.revenue,
      prevRevenue: t.prevRevenue + s.prevRevenue,
      transactions: t.transactions + s.transactions,
      productsCount: t.productsCount + s.productsCount,
      lowStockCount: t.lowStockCount + s.lowStockCount,
      inventoryValue: t.inventoryValue + s.inventoryValue,
      inventoryRetailValue: t.inventoryRetailValue + s.inventoryRetailValue,
      customersCount: t.customersCount + s.customersCount,
      usersCount: t.usersCount + s.usersCount,
    }), { revenue: 0, prevRevenue: 0, transactions: 0, productsCount: 0, lowStockCount: 0, inventoryValue: 0, inventoryRetailValue: 0, customersCount: 0, usersCount: 0 });

    return res.json({ days, stores, totals });
  } catch (error: any) {
    console.error('[stores] my-stores summary failed:', error.message);
    return res.status(500).json({ message: 'Failed to load businesses summary.' });
  }
};

/** Switch the active business — only among stores the user owns. */
export const switchStore = async (req: express.Request, res: express.Response) => {
  try {
    const userId = req.user!.id;
    const { storeId } = req.body || {};
    if (!storeId) return res.status(400).json({ message: 'storeId is required' });
    const owns = await db.query('SELECT id FROM stores WHERE id = $1 AND owner_id = $2', [storeId, userId]);
    if ((owns.rowCount ?? 0) === 0) return res.status(403).json({ message: 'You do not have access to that business.' });
    await db.query('UPDATE users SET current_store_id = $1 WHERE id = $2', [storeId, userId]);
    invalidateUserCache(userId);
    res.json({ success: true, storeId });
  } catch (error: any) {
    res.status(500).json({ message: error.message || 'Failed to switch business.' });
  }
};
