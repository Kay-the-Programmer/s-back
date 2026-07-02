import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { getEnabledModules, setEnabledModules } from '../services/entitlements.service';
import { SUBSCRIPTION_PLANS, getPlans } from '../services/subscription.service';

// Monthly price per plan id (all current plans bill monthly), for MRR.
const PLAN_MONTHLY_PRICE: Record<string, number> = Object.fromEntries(
  SUBSCRIPTION_PLANS.map(p => [p.id, p.interval === 'year' ? p.price / 12 : p.price])
);

/**
 * Grant or revoke premium add-on modules for a store (the controlled "unlock at
 * a fee" path — the platform enables a module after the store pays for it).
 */
export const setStoreModules = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { enabledModules } = req.body as { enabledModules?: string[] };
    if (!Array.isArray(enabledModules)) {
        return res.status(400).json({ message: 'enabledModules must be an array of module ids.' });
    }
    try {
        const exists = await db.query('SELECT 1 FROM store_settings WHERE store_id = $1', [id]);
        if (exists.rowCount === 0) {
            return res.status(404).json({ message: 'Store settings not found. The store must finish setup first.' });
        }
        const saved = await setEnabledModules(id, enabledModules);
        await auditService.log(req.user!, 'Store Modules Updated', `Store ${id}: [${saved.join(', ')}]`);
        return res.status(200).json({ storeId: id, enabledModules: saved });
    } catch (e: any) {
        console.error('Error updating store modules', e);
        return res.status(500).json({ message: 'Failed to update store modules.' });
    }
};

/** Read the premium modules granted to a store. */
export const getStoreModules = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const enabledModules = await getEnabledModules(id);
        return res.status(200).json({ storeId: id, enabledModules });
    } catch (e: any) {
        console.error('Error reading store modules', e);
        return res.status(500).json({ message: 'Failed to read store modules.' });
    }
};

/** Resolve a plan id to its display name (catalog first, constants as fallback). */
const resolvePlanName = (planId: string | null | undefined, plans: { id: string; name: string }[]): string | null => {
  if (!planId) return null;
  return plans.find(p => p.id === planId)?.name
    ?? SUBSCRIPTION_PLANS.find(p => p.id === planId)?.name
    ?? planId;
};

export const listStores = async (req: express.Request, res: express.Response) => {
  try {
    // One row per store, enriched with contact info, seat count and paid
    // subscription revenue so the admin pages can show real details.
    const [result, plans] = await Promise.all([
      db.query(
        `SELECT s.id, s.name, s.status, s.subscription_status, s.subscription_plan,
                s.subscription_ends_at, s.created_at, s.updated_at,
                COALESCE(ss.email, ou.email) AS email,
                COALESCE(ss.phone, ou.phone) AS phone,
                ou.name AS owner_name,
                COALESCE(uc.users_count, 0)::int AS users_count,
                COALESCE(rev.total_revenue, 0)::float AS total_revenue,
                rev.first_paid_at AS subscription_started_at,
                rev.last_paid_at AS last_payment_at
         FROM stores s
         LEFT JOIN store_settings ss ON ss.store_id = s.id
         LEFT JOIN users ou ON ou.id = s.owner_id
         LEFT JOIN (
             SELECT current_store_id, COUNT(*) AS users_count
             FROM users GROUP BY current_store_id
         ) uc ON uc.current_store_id = s.id
         LEFT JOIN (
             SELECT store_id, SUM(amount) AS total_revenue,
                    MIN(paid_at) AS first_paid_at, MAX(paid_at) AS last_paid_at
             FROM subscription_payments
             WHERE paid_at IS NOT NULL
             GROUP BY store_id
         ) rev ON rev.store_id = s.id
         ORDER BY s.created_at DESC`
      ),
      getPlans().catch(() => [] as { id: string; name: string }[]),
    ]);

    const stores = result.rows.map((row: any) => ({
      ...row,
      plan_name: resolvePlanName(row.subscription_plan, plans),
    }));

    return res.status(200).json(toCamelCase({ stores }));
  } catch (e) {
    console.error('Error listing stores', e);
    return res.status(500).json({ message: 'Error listing stores' });
  }
};

export const updateStore = async (req: express.Request, res: express.Response) => {
  try {
    const { id } = req.params;
    const { status, subscriptionStatus, subscriptionEndsAt, subscriptionPlan, reason } = req.body || {};

    if (!id) return res.status(400).json({ message: 'Store id required' });

    // Require a reason for destructive lifecycle changes so the audit trail is accountable.
    if ((status === 'suspended' || status === 'inactive') && !String(reason || '').trim()) {
      return res.status(400).json({ message: 'A reason is required to suspend or deactivate a store.' });
    }

    const fields: string[] = [];
    const params: any[] = [];

    if (status) {
      if (!['active', 'inactive', 'suspended'].includes(status)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      params.push(status);
      fields.push(`status = $${params.length}`);
    }
    if (subscriptionStatus) {
      if (!['trial', 'active', 'past_due', 'canceled'].includes(subscriptionStatus)) {
        return res.status(400).json({ message: 'Invalid subscriptionStatus' });
      }
      params.push(subscriptionStatus);
      fields.push(`subscription_status = $${params.length}`);
    }
    if (subscriptionEndsAt !== undefined) {
      const endsAt = subscriptionEndsAt ? new Date(subscriptionEndsAt) : null;
      if (endsAt && isNaN(endsAt.getTime())) {
        return res.status(400).json({ message: 'Invalid subscriptionEndsAt date' });
      }
      params.push(endsAt);
      fields.push(`subscription_ends_at = $${params.length}`);
    }
    if (subscriptionPlan !== undefined) {
      // Assign or clear the store's plan; validate against the live catalog (with constants fallback).
      if (subscriptionPlan !== null && subscriptionPlan !== '') {
        const plans = await getPlans().catch(() => SUBSCRIPTION_PLANS);
        const known = plans.some(p => p.id === subscriptionPlan) || SUBSCRIPTION_PLANS.some(p => p.id === subscriptionPlan);
        if (!known) return res.status(400).json({ message: `Unknown plan: ${subscriptionPlan}` });
      }
      params.push(subscriptionPlan || null);
      fields.push(`subscription_plan = $${params.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No updates provided' });
    }

    params.push(new Date().toISOString());
    fields.push(`updated_at = $${params.length}`);

    params.push(id);
    const q = `UPDATE stores SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id, name, status, subscription_status, subscription_plan, subscription_ends_at, created_at, updated_at`;

    const result = await db.query(q, params);
    if (result.rowCount === 0) return res.status(404).json({ message: 'Store not found' });

    const updatedStore = result.rows[0];

    // --- Push Notification for Store Updates ---
    if (status || subscriptionStatus) {
      try {
        const { pushService } = await import('../services/push.service');
        let title = 'Store Update ℹ️';
        let body = `Your store "${updatedStore.name}" has been updated by system administration.`;

        if (status === 'suspended') {
          title = 'Store Suspended ⚠️';
          body = `Your store "${updatedStore.name}" has been suspended.${reason ? ` Reason: ${reason}.` : ''} Please contact support.`;
        } else if (subscriptionStatus === 'past_due') {
          title = 'Subscription Past Due 💳';
          body = `Your subscription for "${updatedStore.name}" is past due. Please update payment info.`;
        }

        await pushService.sendToStore(id, {
          title,
          body,
          url: '/settings'
        });
      } catch (pushErr) {
        console.error('Push failed for store update by superadmin:', pushErr);
      }
    }

    // Audit log
    await auditService.log(req.user!, 'Store Updated', `Store ${id}: ${fields.join(', ')}${reason ? ` | reason: ${String(reason).trim()}` : ''}`);

    return res.status(200).json(toCamelCase({ store: result.rows[0] }));
  } catch (e) {
    console.error('Error updating store', e);
    return res.status(500).json({ message: 'Error updating store' });
  }
};

export const createNotification = async (req: express.Request, res: express.Response) => {
  try {
    const { title, message } = req.body || {};
    if (!title || !message) return res.status(400).json({ message: 'Title and message are required' });
    const id = generateId('notif');
    const createdAt = new Date().toISOString();

    // Original system_notifications insert (keeping for audit/history)
    await db.query(
      `INSERT INTO system_notifications (id, title, message, created_at, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [id, title, message, createdAt, req.user!.id]
    );

    // Fan-out: Send to all active stores
    const stores = await db.query("SELECT id FROM stores WHERE status = 'active'");

    const queries = stores.rows.map(store => {
      const notifId = generateId('notif');
      return db.query(
        `INSERT INTO notifications (id, store_id, title, message, type, is_read, reference_id, created_at) VALUES ($1, $2, $3, $4, 'system_priority', false, $5, $6)`,
        [notifId, store.id, title, message, id, createdAt]
      );
    });

    await Promise.all(queries);

    // Send Push Broadcast
    try {
      const { pushService } = await import('../services/push.service');
      await pushService.broadcast({
        title: `📢 ${title}`,
        body: message,
        url: '/notifications'
      });
    } catch (pushErr) {
      console.error('Failed to send push broadcast:', pushErr);
    }

    await auditService.log(req.user!, 'System Notification Sent', `Title: ${title} to ${stores.rows.length} stores`);
    return res.status(201).json(toCamelCase({ notification: { id, title, message, created_at: createdAt, created_by: req.user!.id } }));
  } catch (e) {
    console.error('Error creating notification', e);
    return res.status(500).json({ message: 'Error creating notification' });
  }
};

export const listSystemNotifications = async (req: express.Request, res: express.Response) => {
  try {
    const result = await db.query(`SELECT * FROM system_notifications ORDER BY created_at DESC`);
    return res.status(200).json(toCamelCase({ notifications: result.rows }));
  } catch (e) {
    console.error('Error listing system notifications', e);
    return res.status(500).json({ message: 'Error listing notifications' });
  }
};

export const getNotificationStatus = async (req: express.Request, res: express.Response) => {
  try {
    const { id } = req.params; // system_notification id
    const result = await db.query(`
            SELECT 
                s.name as store_name,
                n.is_read,
                n.created_at as sent_at
            FROM notifications n
            JOIN stores s ON n.store_id = s.id
            WHERE n.reference_id = $1
            ORDER BY n.is_read DESC, s.name ASC
        `, [id]);

    // Also get the original message details
    const original = await db.query('SELECT * FROM system_notifications WHERE id = $1', [id]);

    return res.status(200).json(toCamelCase({
      notification: original.rows[0],
      statuses: result.rows
    }));
  } catch (e) {
    console.error('Error fetching notification status', e);
    return res.status(500).json({ message: 'Error fetching notification status' });
  }
};

export const listRevenueSummary = async (req: express.Request, res: express.Response) => {
  try {
    // Revenue = cash that was actually paid. Pending/cancelled rows (paid_at IS NULL) are excluded.
    const PAID = `paid_at IS NOT NULL`;

    const [totalRes, byMonth, thisMonthRes, storeAgg] = await Promise.all([
      db.query(`SELECT COALESCE(SUM(amount),0) as total_amount, COUNT(*) as count FROM subscription_payments WHERE ${PAID}`),
      db.query(`
        SELECT to_char(date_trunc('month', paid_at), 'YYYY-MM') as month,
               COALESCE(SUM(amount),0) as amount,
               COUNT(*) as count
        FROM subscription_payments
        WHERE ${PAID}
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 12
      `),
      db.query(`
        SELECT COALESCE(SUM(amount),0) as amount
        FROM subscription_payments
        WHERE ${PAID} AND date_trunc('month', paid_at) = date_trunc('month', NOW())
      `),
      // Mutually-exclusive subscription breakdown (one row per store).
      db.query(`SELECT subscription_status, subscription_plan, COUNT(*) as count FROM stores GROUP BY subscription_status, subscription_plan`),
    ]);

    let mrr = 0;
    let activeSubscriptions = 0;
    let activeWithoutPlan = 0;
    let trialCount = 0;
    let pastDueCount = 0;
    let canceledCount = 0;

    for (const row of storeAgg.rows) {
      const n = Number(row.count) || 0;
      switch (row.subscription_status) {
        case 'active': {
          activeSubscriptions += n;
          const price = PLAN_MONTHLY_PRICE[row.subscription_plan];
          if (price) mrr += price * n; else activeWithoutPlan += n;
          break;
        }
        case 'trial': trialCount += n; break;
        case 'past_due': pastDueCount += n; break;
        case 'canceled': canceledCount += n; break;
      }
    }

    return res.status(200).json(toCamelCase({
      summary: {
        totalAmount: Number(totalRes.rows[0]?.total_amount || 0),
        count: Number(totalRes.rows[0]?.count || 0),
        thisMonthCollected: Number(thisMonthRes.rows[0]?.amount || 0),
        byMonth: byMonth.rows,
        mrr: Math.round(mrr * 100) / 100,
        arr: Math.round(mrr * 12 * 100) / 100,
        activeSubscriptions,
        activeWithoutPlan,
        trialCount,
        pastDueCount,
        canceledCount,
        currency: 'ZMW',
      }
    }));
  } catch (e) {
    console.error('Error fetching revenue summary', e);
    return res.status(500).json({ message: 'Error fetching revenue summary' });
  }
};

export const listSubscriptionPayments = async (req: express.Request, res: express.Response) => {
  try {
    const { storeId } = req.query as { storeId?: string };
    const params: any[] = [];
    let where = '';
    if (storeId) {
      params.push(storeId);
      where = `WHERE sp.store_id = $${params.length}`;
    }
    const rows = await db.query(`
      SELECT sp.*, s.name as store_name
      FROM subscription_payments sp
      LEFT JOIN stores s ON s.id = sp.store_id
      ${where}
      ORDER BY COALESCE(sp.paid_at, sp.created_at) DESC
      LIMIT 200
    `, params);
    return res.status(200).json(toCamelCase({ payments: rows.rows }));
  } catch (e) {
    console.error('Error listing subscription payments', e);
    return res.status(500).json({ message: 'Error listing subscription payments' });
  }
};

/**
 * Manually record a subscription payment and *extend* the store's subscription.
 *
 * Strict & accurate workflow:
 *  - Extends from max(now, current expiry) so paying early never burns remaining days.
 *  - Insert + store update run in one transaction with a row lock (no races / partial writes).
 *  - Idempotent on `reference`: re-submitting the same key returns the original payment
 *    instead of double-charging / double-extending.
 *  - Flips the store to `active` and notifies the owner.
 */
export const recordSubscriptionPayment = async (req: express.Request, res: express.Response) => {
  const { storeId, amount, currency, periodDays, paidAt, method, paymentMethod, reference, notes, planId } = req.body || {};

  if (!storeId || amount === undefined || amount === null || !currency) {
    return res.status(400).json({ message: 'storeId, amount and currency are required' });
  }
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
    return res.status(400).json({ message: 'amount must be a positive number' });
  }
  const days = Number.isFinite(Number(periodDays)) && Number(periodDays) > 0 ? Math.floor(Number(periodDays)) : 30;
  const payMethod = method || paymentMethod || 'manual';

  const client = await db._pool.connect();
  try {
    // Idempotency: if this reference was already recorded, return it unchanged.
    if (reference) {
      const existing = await client.query('SELECT * FROM subscription_payments WHERE reference = $1 LIMIT 1', [reference]);
      if (existing.rowCount && existing.rowCount > 0) {
        const storeRow = await client.query('SELECT subscription_ends_at FROM stores WHERE id = $1', [storeId]);
        client.release();
        return res.status(200).json(toCamelCase({
          payment: existing.rows[0],
          subscriptionEndsAt: storeRow.rows[0]?.subscription_ends_at ?? null,
          idempotent: true,
        }));
      }
    }

    await client.query('BEGIN');

    // Lock the store row so concurrent extensions can't race.
    const storeRes = await client.query('SELECT subscription_ends_at FROM stores WHERE id = $1 FOR UPDATE', [storeId]);
    if (storeRes.rowCount === 0) {
      await client.query('ROLLBACK');
      client.release();
      return res.status(404).json({ message: 'Store not found' });
    }

    const now = new Date();
    const currentEnd = storeRes.rows[0].subscription_ends_at ? new Date(storeRes.rows[0].subscription_ends_at) : null;
    const periodStart = currentEnd && currentEnd > now ? currentEnd : now;
    const periodEnd = new Date(periodStart);
    periodEnd.setDate(periodEnd.getDate() + days);

    const paidAtDate = paidAt ? new Date(paidAt) : now;
    const id = generateId('subpay');
    const createdAt = now.toISOString();

    await client.query(
      `INSERT INTO subscription_payments
        (id, store_id, amount, currency, plan_id, period_start, period_end, paid_at, method, reference, notes, status, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'completed',$12)`,
      [id, storeId, numericAmount, currency, planId || null, periodStart, periodEnd, paidAtDate, payMethod, reference || null, notes || null, createdAt]
    );

    await client.query(
      `UPDATE stores SET subscription_status = 'active', subscription_ends_at = $1, updated_at = $2 WHERE id = $3`,
      [periodEnd, createdAt, storeId]
    );

    await client.query('COMMIT');

    await auditService.log(req.user!, 'Subscription Payment Recorded', `Store: ${storeId}, Amount: ${numericAmount} ${currency}, +${days}d (active until ${periodEnd.toISOString().slice(0, 10)})`);

    // Notify the store that their subscription was extended.
    try {
      const { pushService } = await import('../services/push.service');
      await pushService.sendToStore(storeId, {
        title: 'Payment recorded ✅',
        body: `Your subscription is active until ${periodEnd.toISOString().slice(0, 10)}.`,
        url: '/settings/subscription'
      });
    } catch (pushErr) {
      console.error('Push failed for manual payment:', pushErr);
    }

    return res.status(201).json(toCamelCase({
      payment: { id, store_id: storeId, amount: numericAmount, currency, plan_id: planId || null, period_start: periodStart, period_end: periodEnd, paid_at: paidAtDate, method: payMethod, reference: reference || null, notes: notes || null, status: 'completed', created_at: createdAt },
      subscriptionEndsAt: periodEnd,
    }));
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('Error recording subscription payment', e);
    return res.status(500).json({ message: 'Error recording subscription payment' });
  } finally {
    client.release();
  }
};
export const getStoreDetails = async (req: express.Request, res: express.Response) => {
  try {
    const { id } = req.params;

    // parallelize queries for efficiency
    const [storeRes, settingsRes, ownerRes, adminRes, statsRes, revenueRes, paymentsRes, plans] = await Promise.all([
      db.query(`SELECT * FROM stores WHERE id = $1`, [id]),
      db.query(`SELECT * FROM store_settings WHERE store_id = $1`, [id]),
      // Registered owner (multi-store ownership model)
      db.query(`SELECT u.name, u.email, u.phone FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.id = $1`, [id]),
      // Fallback: a user who is likely the owner (admin role + current_store_id matches)
      db.query(`SELECT name, email, phone FROM users WHERE current_store_id = $1 AND role = 'admin' LIMIT 1`, [id]),
      // Usage stats (users, products, sales) in one round trip
      db.query(
        `SELECT
            (SELECT COUNT(*) FROM users WHERE current_store_id = $1)::int AS users_count,
            (SELECT COUNT(*) FROM products WHERE store_id = $1)::int AS products_count,
            (SELECT COUNT(*) FROM sales WHERE store_id = $1)::int AS sales_count,
            (SELECT COALESCE(SUM(total), 0) FROM sales WHERE store_id = $1)::float AS sales_total`,
        [id]
      ),
      // Paid subscription revenue for this store
      db.query(
        `SELECT COALESCE(SUM(amount), 0)::float AS total_revenue,
                COUNT(*)::int AS payments_count,
                MIN(paid_at) AS first_paid_at,
                MAX(paid_at) AS last_paid_at
         FROM subscription_payments WHERE store_id = $1 AND paid_at IS NOT NULL`,
        [id]
      ),
      // Recent payment history (paid + pending) for the billing panel
      db.query(
        `SELECT id, amount, currency, plan_id, period_start, period_end, paid_at, method, reference, status, notes, created_at
         FROM subscription_payments WHERE store_id = $1
         ORDER BY COALESCE(paid_at, created_at) DESC
         LIMIT 20`,
        [id]
      ),
      getPlans().catch(() => [] as { id: string; name: string }[]),
    ]);

    if (storeRes.rowCount === 0) {
      return res.status(404).json({ message: 'Store not found' });
    }

    const store = storeRes.rows[0];
    const settings = settingsRes.rows[0] || {};
    const owner = ownerRes.rows[0] || adminRes.rows[0] || {};
    const stats = statsRes.rows[0] || {};
    const revenue = revenueRes.rows[0] || {};

    // Merge info for the frontend
    const detailedStore = {
      ...store,
      plan: store.subscription_plan,
      planName: resolvePlanName(store.subscription_plan, plans),
      address: settings.address,
      phone: settings.phone || owner.phone, // fallback to owner phone
      email: settings.email || owner.email, // fallback to owner email
      ownerName: owner.name,
      ownerEmail: owner.email,
      usersCount: Number(stats.users_count || 0),
      productsCount: Number(stats.products_count || 0),
      salesCount: Number(stats.sales_count || 0),
      salesTotal: Number(stats.sales_total || 0),
      totalRevenue: Number(revenue.total_revenue || 0),
      paymentsCount: Number(revenue.payments_count || 0),
      subscriptionStartedAt: revenue.first_paid_at || null,
      lastPaymentAt: revenue.last_paid_at || null,
    };

    return res.status(200).json(toCamelCase({ store: detailedStore, payments: paymentsRes.rows }));
  } catch (e) {
    console.error('Error fetching store details', e);
    return res.status(500).json({ message: 'Error fetching store details' });
  }
};

export const sendStoreNotification = async (req: express.Request, res: express.Response) => {
  try {
    const { id } = req.params; // store id
    const { title, message, type } = req.body;

    if (!title || !message) {
      return res.status(400).json({ message: 'Title and message are required' });
    }

    // Verify store exists
    const storeCheck = await db.query('SELECT 1 FROM stores WHERE id = $1', [id]);
    if (storeCheck.rowCount === 0) {
      return res.status(404).json({ message: 'Store not found' });
    }

    const notifId = generateId('notif');
    const createdAt = new Date().toISOString();

    await db.query(
      `INSERT INTO notifications (id, store_id, title, message, type, is_read, created_at) 
             VALUES ($1, $2, $3, $4, $5, false, $6)`,
      [notifId, id, title, message, type || 'system_targeted', createdAt]
    );

    // Send Push Notification to store users
    try {
      const { pushService } = await import('../services/push.service');
      await pushService.sendToStore(id, {
        title: `⚠️ ${title}`,
        body: message,
        url: '/notifications'
      });
    } catch (pushErr) {
      console.error('Failed to send push notification to store:', pushErr);
    }

    // Also log this as a system notification reference if we want global tracking? 
    // For simple targeted messaging, just inserting into local notifications is enough, 
    // but let's log audit.
    await auditService.log(req.user!, 'Store Notification Sent', `To Store ${id}: ${title}`);

    return res.status(201).json({ message: 'Notification sent successfully' });
  } catch (e) {
    console.error('Error sending store notification', e);
    return res.status(500).json({ message: 'Error sending notification' });
  }
};
