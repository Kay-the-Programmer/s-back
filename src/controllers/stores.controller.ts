import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';

export const registerStore = async (req: express.Request, res: express.Response) => {
  try {
    const user = req.user!;
    const { name } = req.body || {};

    if (!user || !user.id) {
      return res.status(401).json({ message: 'Unauthorized' });
    }
    if (!name || String(name).trim().length < 2) {
      return res.status(400).json({ message: 'Store name is required' });
    }

    const storeId = generateId('store');

    await db.query('BEGIN');
    try {
      // Insert with explicit defaults to accommodate legacy schemas missing column defaults
      await db.query("INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')", [storeId, String(name).trim()]);
      // Make the registering user an admin for now (global role) and set current store
      await db.query('UPDATE users SET role = $1, current_store_id = $2 WHERE id = $3', ['admin', storeId, user.id]);
      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }

    // Return the created store and updated user context
    const store = (await db.query('SELECT id, name, created_at FROM stores WHERE id = $1', [storeId])).rows[0];
    return res.status(201).json(toCamelCase({ store }));
  } catch (error) {
    console.error('Error registering store:', error);
    return res.status(500).json({ message: 'Error registering store' });
  }
};
