import express from 'express';
import db from '../db_client';
import { Return, Sale, Product, StoreSettings } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';

export const getReturns = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query(`
            SELECT r.*, COALESCE(json_agg(ri.*) FILTER (WHERE ri.id IS NOT NULL), '[]') as "returnedItems"
            FROM returns r
                     LEFT JOIN return_items ri ON r.id = ri.return_id
            WHERE r.store_id = $1
            GROUP BY r.id, r.timestamp
            ORDER BY r.timestamp DESC
        `, [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching returns:', error);
        res.status(500).json({ message: 'Error fetching returns' });
    }
};

export const createReturn = async (req: express.Request, res: express.Response) => {
    const returnData: Omit<Return, 'id' | 'timestamp'> = req.body;
    const { originalSaleId, returnedItems, refundAmount, refundMethod } = returnData;
    const id = generateId('ret');
    const timestamp = new Date().toISOString();

    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    const client = await db._pool.connect();
    try {
        await client.query('BEGIN');

        const saleResult = await client.query('SELECT * FROM sales WHERE transaction_id = $1 AND store_id = $2', [originalSaleId, storeId]);
        if (saleResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Original sale not found' });
        }
        const originalSale = toCamelCase(saleResult.rows[0]);

        // 1. Create the return record
        const returnResult = await client.query(
            'INSERT INTO returns (id, original_sale_id, "timestamp", refund_amount, refund_method, store_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
            [id, originalSaleId, timestamp, refundAmount, refundMethod, storeId]
        );
        const newReturn = toCamelCase(returnResult.rows[0]);

        // 2. Process each returned item
        for (const item of returnedItems) {
            await client.query(
                'INSERT INTO return_items (return_id, product_id, product_name, quantity, reason, add_to_stock, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [id, item.productId, item.productName, item.quantity, item.reason, item.addToStock, storeId]
            );

            if (item.addToStock) {
                await client.query(
                    'UPDATE products SET stock = stock + $1 WHERE id = $2 AND store_id = $3',
                    [item.quantity, item.productId, storeId]
                );
            }

            // Update sale_items to track returned quantity
            await client.query(
                'UPDATE sale_items SET returned_quantity = returned_quantity + $1 WHERE sale_id = $2 AND product_id = $3 AND store_id = $4',
                [item.quantity, originalSaleId, item.productId, storeId]
            );
        }

        // 3. Update customer store credit if applicable
        if (refundMethod === 'store_credit') {
            if (!originalSale.customerId) {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Cannot refund to store credit: no customer on original sale.' });
            }
            await client.query('UPDATE customers SET store_credit = store_credit + $1 WHERE id = $2 AND store_id = $3', [refundAmount, originalSale.customerId, storeId]);
        }

        // 4. Update original sale's refund status
        const totalRefundedResult = await client.query('SELECT SUM(refund_amount) as total_refunded FROM returns WHERE original_sale_id = $1 AND store_id = $2', [originalSaleId, storeId]);
        const totalRefundedSum = Number(totalRefundedResult.rows[0]?.total_refunded || 0);

        const originalBaseTotal = Number(originalSale.total);
        let newStatus = 'partially_returned';
        if (totalRefundedSum >= originalBaseTotal - 0.01) {
            newStatus = 'returned';
        }

        await client.query(
            "UPDATE sales SET refund_status = $1 WHERE transaction_id = $2 AND store_id = $3",
            [newStatus, originalSaleId, storeId]
        );

        // 5. Accounting and Auditing
        // Fetch cart items for the sale to pass to accounting (needed for price levels)
        const cartResult = await client.query('SELECT * FROM sale_items WHERE sale_id = $1 AND store_id = $2', [originalSaleId, storeId]);
        const enrichedSale = { ...originalSale, cart: toCamelCase(cartResult.rows) };

        await accountingService.recordReturn({ ...newReturn, returnedItems }, enrichedSale, client, storeId);
        await auditService.log(req.user!, 'Return Processed', `For Sale ID: ${originalSaleId}, Amount: ${refundAmount.toFixed(2)}`, client);

        await client.query('COMMIT');
        res.status(201).json({ ...newReturn, returnedItems });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating return:', error);
        res.status(500).json({ message: 'Error processing return' });
    } finally {
        client.release();
    }
};