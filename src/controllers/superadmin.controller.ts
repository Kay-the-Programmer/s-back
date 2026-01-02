import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';

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
    await db.query(
      `INSERT INTO system_notifications (id, title, message, created_at, created_by) VALUES ($1, $2, $3, $4, $5)`,
      [id, title, message, createdAt, req.user!.id]
    );
    await auditService.log(req.user!, 'System Notification Sent', `Title: ${title}`);
    return res.status(201).json(toCamelCase({ notification: { id, title, message, created_at: createdAt, created_by: req.user!.id } }));
  } catch (e) {
    console.error('Error creating notification', e);
    return res.status(500).json({ message: 'Error creating notification' });
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
