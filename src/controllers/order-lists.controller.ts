import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';

/**
 * Order lists ("Quick Lists") — lightweight restock checklists from the Hustle /
 * Purchase Orders app. No supplier or catalogue required; items live inline as
 * JSONB. Every list is scoped to the caller's store.
 */

// created_at / imported_at are BIGINT (epoch ms). node-pg returns BIGINT as a
// string, so coerce back to the numeric shape the web client expects.
const normalize = (row: any) => {
    const list = toCamelCase(row);
    list.createdAt = list.createdAt != null ? Number(list.createdAt) : Date.now();
    list.importedAt = list.importedAt != null ? Number(list.importedAt) : undefined;
    list.items = Array.isArray(list.items) ? list.items : [];
    return list;
};

export const getOrderLists = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const result = await db.query(
            'SELECT * FROM order_lists WHERE store_id = $1 ORDER BY created_at DESC',
            [storeId]
        );
        res.status(200).json(result.rows.map(normalize));
    } catch (error) {
        console.error('Error fetching order lists:', error);
        res.status(500).json({ message: 'Error fetching order lists' });
    }
};

/**
 * Upsert a list. Used for both create and edit so it is idempotent under offline
 * queue replays — re-sending the same client id can never duplicate a list.
 */
export const upsertOrderList = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const { id, title, items, createdAt, importedAt } = req.body || {};
        const listId = (typeof id === 'string' && id) ? id : generateId('ql');

        const result = await db.query(
            `INSERT INTO order_lists (id, title, items, created_at, imported_at, store_id, updated_at)
             VALUES ($1, $2, $3::jsonb, $4, $5, $6, NOW())
             ON CONFLICT (id) DO UPDATE
                 SET title = EXCLUDED.title,
                     items = EXCLUDED.items,
                     imported_at = EXCLUDED.imported_at,
                     updated_at = NOW()
                 WHERE order_lists.store_id = EXCLUDED.store_id
             RETURNING *`,
            [
                listId,
                (typeof title === 'string' && title.trim()) ? title : 'Order list',
                JSON.stringify(Array.isArray(items) ? items : []),
                Number(createdAt) || Date.now(),
                importedAt != null ? Number(importedAt) : null,
                storeId,
            ]
        );

        // Empty result means the id exists under a different store (conflict
        // update was blocked by the WHERE guard) — refuse rather than leak.
        if (!result.rows[0]) {
            return res.status(409).json({ message: 'Order list belongs to a different store' });
        }
        res.status(201).json(normalize(result.rows[0]));
    } catch (error) {
        console.error('Error saving order list:', error);
        res.status(500).json({ message: 'Error saving order list' });
    }
};

export const deleteOrderList = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const storeId = req.tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const result = await db.query(
            'DELETE FROM order_lists WHERE id = $1 AND store_id = $2 RETURNING id',
            [id, storeId]
        );
        if ((result.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'Order list not found' });
        }
        try { auditService.log(req.user!, 'Order List Deleted', `List ID: ${id}`); } catch { /* non-fatal */ }
        res.status(200).json({ message: 'Order list deleted' });
    } catch (error) {
        console.error(`Error deleting order list ${id}:`, error);
        res.status(500).json({ message: 'Error deleting order list' });
    }
};
