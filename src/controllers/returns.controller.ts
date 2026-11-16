import express from 'express';
import db from '../db_client';
import { Return, Sale, Product, StoreSettings } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';
import { findOpenSessionId } from '../services/cash-session.service';
import { reversePointsForReturn } from '../services/loyalty.service';
import { computeRefund } from '../services/refund';
import { requiresOverride } from '../services/override-rules';
import {
    OverrideError,
    canSelfAuthorize,
    consumeOverride,
    loadThresholds,
} from '../services/override.service';

export const getReturns = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
        }
        const result = await db.query(`
            SELECT r.*, COALESCE(json_agg(ri.*) FILTER (WHERE ri.id IS NOT NULL), '[]') as "returnedItems"
            FROM returns r
                     LEFT JOIN return_items ri ON r.id = ri.return_id
            WHERE r.store_id = $1
            GROUP BY r.id, r.timestamp
            ORDER BY r.timestamp DESC
            LIMIT 500
        `, [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching returns:', error);
        res.status(500).json({ message: 'Error fetching returns' });
    }
};

export const createReturn = async (req: express.Request, res: express.Response) => {
    const returnData: Omit<Return, 'id' | 'timestamp'> = req.body;
    // refundAmount from the client is ignored: the server works it out below.
    const { originalSaleId, returnedItems, refundMethod } = returnData;
    // On an exchange, part of the refund is settled in replacement goods rather
    // than money. Recording how much keeps 'cash paid out' derivable
    // (refund_amount - exchange_credit_applied) instead of guessed.
    const exchangeCreditApplied = Math.max(0, Number((returnData as any).exchangeCreditApplied) || 0);
    const id = generateId('ret');
    const timestamp = new Date().toISOString();

    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
    }
    if (!Array.isArray(returnedItems) || returnedItems.length === 0) {
        return res.status(400).json({ message: 'Choose at least one item to return.' });
    }

    // How much to give back is the server's call, from the sale as it was
    // charged (services/refund). The figure the till sends is not trusted: it
    // used to add the store's flat tax rate to every line, over-refunding
    // zero-rated, exempt and tax-inclusive goods.
    let refundAmount: number;
    let refundTax: number;
    let refundSubtotal: number;
    {
        const saleRow = await db.query(
            'SELECT total, subtotal, delivery_fee, tax_breakdown FROM sales WHERE transaction_id = $1 AND store_id = $2',
            [originalSaleId, storeId],
        );
        if (!saleRow.rowCount) return res.status(404).json({ message: 'Original sale not found' });
        const soldRows = await db.query(
            'SELECT product_id, price_at_sale, quantity, returned_quantity, tax_class FROM sale_items WHERE sale_id = $1 AND store_id = $2',
            [originalSaleId, storeId],
        );
        const prior = await db.query(
            'SELECT COALESCE(SUM(refund_amount), 0) AS refunded FROM returns WHERE original_sale_id = $1 AND store_id = $2',
            [originalSaleId, storeId],
        );
        const rate = await db.query('SELECT tax_rate FROM store_settings WHERE store_id = $1', [storeId]);
        const s = saleRow.rows[0];
        let breakdown = s.tax_breakdown;
        if (typeof breakdown === 'string') { try { breakdown = JSON.parse(breakdown); } catch { breakdown = null; } }
        const refund = computeRefund(
            soldRows.rows.map((r: any) => ({
                productId: r.product_id,
                price: Number(r.price_at_sale) || 0,
                quantity: Number(r.quantity) || 0,
                returned: Number(r.returned_quantity) || 0,
                taxClass: r.tax_class,
            })),
            returnedItems.map(i => ({ productId: i.productId, quantity: Number(i.quantity) || 0 })),
            {
                subtotal: Number(s.subtotal) || 0,
                total: Number(s.total) || 0,
                deliveryFee: Number(s.delivery_fee) || 0,
                taxBreakdown: Array.isArray(breakdown) ? breakdown : null,
                alreadyRefunded: Number(prior.rows[0]?.refunded) || 0,
            },
            Number(rate.rows[0]?.tax_rate) || 0,
        );
        refundAmount = refund.amount;
        refundTax = refund.tax;
        refundSubtotal = refund.net;
    }

    // A large refund is where a till leaks money: goods that never came back,
    // signed off by nobody. Past the store's limit it takes a manager, and the
    // approval names them in the audit log.
    if (!canSelfAuthorize(req.user?.role)) {
        const thresholds = await loadThresholds(storeId);
        if (requiresOverride('refund', Number(refundAmount) || 0, thresholds)) {
            try {
                const { authorizedBy } = await consumeOverride({
                    overrideId: (returnData as any).overrideId,
                    storeId,
                    action: 'refund',
                    amount: Number(refundAmount) || 0,
                });
                await auditService.log(
                    req.user!,
                    'Refund Override Used',
                    `Refund of ${Number(refundAmount).toFixed(2)} on ${originalSaleId}, approved by ${authorizedBy}`,
                );
            } catch (e) {
                if (e instanceof OverrideError) {
                    return res.status(403).json({
                        message: e.message,
                        requiresOverride: 'refund',
                        amount: Number(refundAmount) || 0,
                    });
                }
                throw e;
            }
        }
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

        // 0. Validate against the original sale — a return can never exceed what
        // was sold (per line) or refund more than has been charged (cumulatively).
        const saleItemsResult = await client.query(
            'SELECT product_id, quantity, returned_quantity FROM sale_items WHERE sale_id = $1 AND store_id = $2',
            [originalSaleId, storeId]
        );
        const saleItemMap = new Map<string, any>(saleItemsResult.rows.map((r: any) => [r.product_id, r]));
        for (const item of returnedItems) {
            const si = saleItemMap.get(item.productId);
            const remainingQty = si ? Number(si.quantity) - Number(si.returned_quantity) : 0;
            if (!si || !(Number(item.quantity) > 0) || Number(item.quantity) > remainingQty + 0.0001) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: `Cannot return ${item.quantity} × ${item.productName || item.productId}: only ${Math.max(0, remainingQty)} eligible for return on this sale.`
                });
            }
        }
        const priorRefundsResult = await client.query(
            'SELECT COALESCE(SUM(refund_amount), 0) as refunded FROM returns WHERE original_sale_id = $1 AND store_id = $2',
            [originalSaleId, storeId]
        );
        const alreadyRefunded = Number(priorRefundsResult.rows[0]?.refunded || 0);
        const refundable = Number(originalSale.total) - alreadyRefunded;
        if (!(Number(refundAmount) >= 0) || Number(refundAmount) > refundable + 0.01) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                message: `Refund of ${Number(refundAmount).toFixed(2)} exceeds the refundable balance of ${Math.max(0, refundable).toFixed(2)} for this sale.`
            });
        }

        // 1. Create the return record (amount, tax and net computed above).

        // Attribute the refund to the till it was paid out of, so a cash
        // refund shows up as money that left the drawer rather than as a
        // shortage at closing time.
        const cashSessionId = await findOpenSessionId(storeId, req.user?.id);

        const returnResult = await client.query(
            'INSERT INTO returns (id, original_sale_id, "timestamp", refund_amount, tax_amount, subtotal_amount, refund_method, exchange_credit_applied, store_id, cash_session_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *',
            [id, originalSaleId, timestamp, refundAmount, refundTax, refundSubtotal, refundMethod, Math.min(exchangeCreditApplied, Number(refundAmount) || 0), storeId, cashSessionId]
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
        } else if (refundMethod === 'accounts_receivable' || refundMethod === 'on_account') {
            if (originalSale.customerId) {
                await client.query('UPDATE customers SET account_balance = account_balance - $1 WHERE id = $2 AND store_id = $3', [refundAmount, originalSale.customerId, storeId]);
            }
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

        // Take back the loyalty points this refund corresponds to, at the rate
        // the sale earned them at — not today's, which may have changed since.
        if (originalSale.customerId) {
            await reversePointsForReturn({
                storeId,
                saleId: originalSaleId,
                returnId: id,
                refundAmount: Number(refundAmount) || 0,
                saleTotal: Number(originalSale.total) || 0,
                returnedAt: timestamp,
            }, client);
        }

        await accountingService.recordReturn({ ...newReturn, returnedItems }, enrichedSale, client, storeId);
        await auditService.log(req.user!, 'Return Processed', `For Sale ID: ${originalSaleId}, Amount: ${refundAmount.toFixed(2)}`, client);

        await client.query('COMMIT');

        // Answer first; the till shows the confirmed amount from this reply.
        res.status(201).json({ ...newReturn, refundAmount, returnedItems });

        // --- Push Notification for Return (fire-and-forget) ---
        void (async () => {
            try {
                const { pushService } = await import('../services/push.service');
                await pushService.sendToStore(storeId, {
                    title: 'Return Processed 🔙',
                    body: `Return of ${refundAmount.toFixed(2)} for Sale ID ${originalSaleId}.`,
                    url: `/returns`
                });
            } catch (pushErr) {
                console.error('Push failed for return:', pushErr);
            }
        })();

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating return:', error);
        if ((error as any)?.code === 'BOOKS_LOCKED') return res.status(409).json({ message: (error as any).message, booksLockedUntil: (error as any).lockedUntil });
        res.status(500).json({ message: 'Error processing return' });
    } finally {
        client.release();
    }
};
/**
 * Record how much of a refund was settled in replacement goods.
 *
 * The till only learns this once the replacement items have been rung up,
 * which is after the return itself is recorded — recording the return first is
 * deliberate, so goods handed back are never lost if the sale is abandoned.
 * This closes the loop: `refund_amount - exchange_credit_applied` is the cash
 * that actually left the drawer, so an end-of-shift count can be checked.
 *
 * Money is not moved here. The ledger already balances through the return and
 * the replacement sale; this only labels what the refund was settled with.
 */
export const setExchangeCreditApplied = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const applied = Number(req.body?.exchangeCreditApplied);

    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
    }
    if (!Number.isFinite(applied) || applied < 0) {
        return res.status(400).json({ message: 'The exchange credit cannot be a negative amount.' });
    }

    try {
        const result = await db.query(
            `UPDATE returns
                SET exchange_credit_applied = LEAST($1, refund_amount)
              WHERE id = $2 AND store_id = $3
              RETURNING *`,
            [applied, id, storeId],
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Return not found' });
        }
        return res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error(`Error setting exchange credit for return ${id}:`, error);
        return res.status(500).json({ message: 'Error updating the return' });
    }
};
