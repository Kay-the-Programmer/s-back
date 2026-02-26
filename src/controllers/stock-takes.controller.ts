import express from 'express';
import db from '../db_client';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';
import { toCamelCase } from '../utils/helpers';

const getActiveSessionWithItems = async (storeId: string) => {
    const sessionRes = await db.query("SELECT * FROM stock_takes WHERE status = 'active' AND store_id = $1 LIMIT 1", [storeId]);
    if ((sessionRes.rowCount ?? 0) === 0) return null;
    const session = sessionRes.rows[0];

    const itemsRes = await db.query("SELECT * FROM stock_take_items WHERE stock_take_id = $1 AND store_id = $2 ORDER BY name", [session.id, storeId]);
    session.items = itemsRes.rows;
    return session;
}

export const getActiveStockTake = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const session = await getActiveSessionWithItems(storeId);
        res.status(200).json(toCamelCase(session));
    } catch (error) {
        console.error("Error fetching active stock take:", error);
        res.status(500).json({ message: "Error fetching active stock take" });
    }
};

export const startStockTake = async (req: express.Request, res: express.Response) => {
    // Should be a transaction
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const existing = await db.query("SELECT id FROM stock_takes WHERE status = 'active' AND store_id = $1 LIMIT 1", [storeId]);
        if ((existing.rowCount ?? 0) > 0) {
            return res.status(400).json({ message: 'A stock take is already in progress.' });
        }

        const id = `st_${Date.now()}`;
        const startTime = new Date().toISOString();
        await db.query("INSERT INTO stock_takes (id, start_time, status, store_id) VALUES ($1, $2, 'active', $3)", [id, startTime, storeId]);

        const products = await db.query("SELECT id, name, sku, stock FROM products WHERE (status = 'active' OR status IS NULL) AND store_id = $1", [storeId]);
        for (const p of products.rows) {
            await db.query(
                "INSERT INTO stock_take_items (stock_take_id, product_id, name, sku, expected, counted, store_id) VALUES ($1, $2, $3, $4, $5, NULL, $6)",
                [id, p.id, p.name, p.sku ?? '', p.stock, storeId]
            );
        }

        const newSession = await getActiveSessionWithItems(storeId);
        auditService.log(req.user!, 'Stock Take Started', `Session ID: ${id}`);
        res.status(201).json(toCamelCase(newSession));
    } catch (error) {
        console.error("Error starting stock take:", error);
        res.status(500).json({ message: "Error starting stock take" });
    }
};

export const updateStockTakeItem = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const session = await db.query("SELECT id FROM stock_takes WHERE status = 'active' AND store_id = $1 LIMIT 1", [storeId]);
        if ((session.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'No active stock take session.' });
        }
        const sessionId = session.rows[0].id;
        const { productId } = req.params;
        const { count } = req.body;

        await db.query("UPDATE stock_take_items SET counted = $1 WHERE stock_take_id = $2 AND product_id = $3 AND store_id = $4", [count, sessionId, productId, storeId]);

        const updatedSession = await getActiveSessionWithItems(storeId);
        res.status(200).json(toCamelCase(updatedSession));
    } catch (error) {
        console.error("Error updating stock take item:", error);
        res.status(500).json({ message: "Error updating stock take item" });
    }
};

export const cancelStockTake = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const sessionRes = await db.query("SELECT id FROM stock_takes WHERE status = 'active' AND store_id = $1 LIMIT 1", [storeId]);
        if ((sessionRes.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'No active stock take session to cancel.' });
        }
        const sessionId = sessionRes.rows[0].id;
        // ON DELETE CASCADE will remove items
        await db.query("DELETE FROM stock_takes WHERE id = $1 AND store_id = $2", [sessionId, storeId]);

        auditService.log(req.user!, 'Stock Take Canceled', `Session ID: ${sessionId}`);
        res.status(200).json({ message: 'Stock take cancelled.' });
    } catch (error) {
        console.error("Error canceling stock take:", error);
        res.status(500).json({ message: "Error canceling stock take" });
    }
};

export const finalizeStockTake = async (req: express.Request, res: express.Response) => {
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    const client = await (db as any)._pool.connect();
    try {
        const session = await getActiveSessionWithItems(storeId);
        if (!session) {
            return res.status(404).json({ message: 'No active stock take session to finalize.' });
        }

        await client.query('BEGIN');

        let totalAdjustmentValue = 0;

        for (const item of session.items) {
            if (item.counted !== null && Number(item.counted) !== Number(item.expected)) {
                // Fetch current cost price to value the adjustment
                const productRes = await client.query("SELECT cost_price FROM products WHERE id = $1 AND store_id = $2", [item.productId, storeId]);
                const costPrice = productRes.rowCount > 0 ? parseFloat(productRes.rows[0].cost_price || 0) : 0;
                const diff = Number(item.counted) - Number(item.expected);
                totalAdjustmentValue += (diff * costPrice);

                await client.query("UPDATE products SET stock = $1 WHERE id = $2 AND store_id = $3", [item.counted, item.productId, storeId]);
            }
        }

        const endTime = new Date().toISOString();
        await client.query("UPDATE stock_takes SET status = 'completed', end_time = $1 WHERE id = $2 AND store_id = $3", [endTime, session.id, storeId]);

        if (Math.abs(totalAdjustmentValue) > 0.01) {
            await accountingService.recordConsolidatedStockAdjustment(
                totalAdjustmentValue,
                `Stock take adjustment (Session: ${session.id})`,
                client,
                storeId
            );
        }

        await client.query('COMMIT');

        // --- Push Notification for Stock Take ---
        try {
            const { pushService } = await import('../services/push.service');
            await pushService.sendToStore(storeId, {
                title: 'Stock Take Complete ✅',
                body: `Stock take ${session.id} finished. Total inventory adjustment value: ${totalAdjustmentValue.toFixed(2)}.`,
                url: `/inventory`
            });
        } catch (pushErr) {
            console.error('Push failed for stock take finalize:', pushErr);
        }

        auditService.log(req.user!, 'Stock Take Finalized', `Session ID: ${session.id}. Total Adj: ${totalAdjustmentValue.toFixed(2)}`);
        res.status(200).json({ message: 'Stock take finalized and inventory journal updated.' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error("Error finalizing stock take:", error);
        res.status(500).json({ message: "Error finalizing stock take" });
    } finally {
        client.release();
    }
};