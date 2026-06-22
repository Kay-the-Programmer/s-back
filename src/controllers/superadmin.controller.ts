import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { getEnabledModules, setEnabledModules } from '../services/entitlements.service';

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

export const listStores = async (req: express.Request, res: express.Response) => {
  try {
    const result = await db.query(
      `SELECT id, name, status, subscription_status, subscription_ends_at, created_at, updated_at FROM stores ORDER BY created_at DESC`
    );
    return res.status(200).json(toCamelCase({ stores: result.rows }));
  } catch (e) {
    console.error('Error listing stores', e);
    return res.status(500).json({ message: 'Error listing stores' });
  }
};

export const updateStore = async (req: express.Request, res: express.Response) => {
  try {
    const { id } = req.params;
    const { status, subscriptionStatus, subscriptionEndsAt } = req.body || {};

    if (!id) return res.status(400).json({ message: 'Store id required' });

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
      params.push(subscriptionEndsAt ? new Date(subscriptionEndsAt) : null);
      fields.push(`subscription_ends_at = $${params.length}`);
    }

    if (fields.length === 0) {
      return res.status(400).json({ message: 'No updates provided' });
    }

    params.push(new Date().toISOString());
    fields.push(`updated_at = $${params.length}`);

    params.push(id);
    const q = `UPDATE stores SET ${fields.join(', ')} WHERE id = $${params.length} RETURNING id, name, status, subscription_status, subscription_ends_at, created_at, updated_at`;

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
          body = `Your store "${updatedStore.name}" has been suspended. Please contact support.`;
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
    await auditService.log(req.user!, 'Store Updated', `Store ${id} updated by superadmin: ${fields.join(', ')}`);

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
    const totalRes = await db.query(`SELECT COALESCE(SUM(amount),0) as total_amount, COUNT(*) as count FROM subscription_payments`);
    const byMonth = await db.query(`
      SELECT to_char(date_trunc('month', COALESCE(paid_at, created_at)), 'YYYY-MM') as month,
             COALESCE(SUM(amount),0) as amount,
             COUNT(*) as count
      FROM subscription_payments
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT 12
    `);
    return res.status(200).json(toCamelCase({
      summary: {
        totalAmount: Number(totalRes.rows[0]?.total_amount || 0),
        count: Number(totalRes.rows[0]?.count || 0),
        byMonth: byMonth.rows
      }
    }));
  } catch (e) {
    console.error('Error fetching revenue summary', e);
    return res.status(500).json({ message: 'Error fetching revenue summary' });
  }
};

export const listSubscriptionPayments = async (req: express.Request, res: express.Response) => {
  try {
    const rows = await db.query(`
      SELECT sp.*, s.name as store_name
      FROM subscription_payments sp
      LEFT JOIN stores s ON s.id = sp.store_id
      ORDER BY COALESCE(sp.paid_at, sp.created_at) DESC
      LIMIT 200
    `);
    return res.status(200).json(toCamelCase({ payments: rows.rows }));
  } catch (e) {
    console.error('Error listing subscription payments', e);
    return res.status(500).json({ message: 'Error listing subscription payments' });
  }
};

export const recordSubscriptionPayment = async (req: express.Request, res: express.Response) => {
  try {
    const { storeId, amount, currency, periodStart, periodEnd, paidAt, method, reference, notes } = req.body || {};
    if (!storeId || !amount || !currency) return res.status(400).json({ message: 'storeId, amount and currency are required' });
    const id = generateId('subpay');
    const createdAt = new Date().toISOString();
    await db.query(
      `INSERT INTO subscription_payments (id, store_id, amount, currency, period_start, period_end, paid_at, method, reference, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, storeId, amount, currency, periodStart ? new Date(periodStart) : null, periodEnd ? new Date(periodEnd) : null, paidAt ? new Date(paidAt) : null, method || null, reference || null, notes || null, createdAt]
    );
    await auditService.log(req.user!, 'Subscription Payment Recorded', `Store: ${storeId}, Amount: ${amount} ${currency}`);
    return res.status(201).json(toCamelCase({ payment: { id, store_id: storeId, amount, currency, period_start: periodStart, period_end: periodEnd, paid_at: paidAt, method, reference, notes, created_at: createdAt } }));
  } catch (e) {
    console.error('Error recording subscription payment', e);
    return res.status(500).json({ message: 'Error recording subscription payment' });
  }
};
export const getStoreDetails = async (req: express.Request, res: express.Response) => {
  try {
    const { id } = req.params;

    // parallelize queries for efficiency
    const [storeRes, settingsRes, ownerRes, statsRes] = await Promise.all([
      db.query(`SELECT * FROM stores WHERE id = $1`, [id]),
      db.query(`SELECT * FROM store_settings WHERE store_id = $1`, [id]),
      // Find a user who is likely the owner (admin role + current_store_id matches)
      db.query(`SELECT name, email, phone FROM users WHERE current_store_id = $1 AND role = 'admin' LIMIT 1`, [id]),
      // Quick usage stats
      db.query(`SELECT COUNT(*) as users_count FROM users WHERE current_store_id = $1`, [id])
    ]);

    if (storeRes.rowCount === 0) {
      return res.status(404).json({ message: 'Store not found' });
    }

    const store = storeRes.rows[0];
    const settings = settingsRes.rows[0] || {};
    const owner = ownerRes.rows[0] || {};
    const stats = statsRes.rows[0] || {};

    // Merge info for the frontend
    const detailedStore = {
      ...store,
      address: settings.address,
      phone: settings.phone || owner.phone, // fallback to owner phone
      email: settings.email || owner.email, // fallback to owner email
      ownerName: owner.name,
      usersCount: parseInt(stats.users_count || '0')
    };

    return res.status(200).json(toCamelCase({ store: detailedStore }));
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
