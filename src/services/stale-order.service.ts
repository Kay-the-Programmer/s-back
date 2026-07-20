import db from '../db_client';
import { toCamelCase } from '../utils/helpers';
import { accountingService } from './accounting.service';
import { pushService } from './push.service';

/**
 * Auto-cancel stale unpaid online orders.
 *
 * Online checkout decrements stock at order time (so the shop can't oversell),
 * but orders are pay-on-delivery — an abandoned/no-show order would otherwise
 * hold that stock hostage until the owner noticed and cancelled it by hand.
 * This job cancels `pending` + `unpaid` online orders older than
 * ONLINE_ORDER_EXPIRY_DAYS (default 3), restoring stock and reversing the
 * books exactly like a manual cancel in updateFulfillmentStatus.
 */
const EXPIRY_DAYS = Math.max(1, parseInt(process.env.ONLINE_ORDER_EXPIRY_DAYS || '3', 10) || 3);

const cancelStaleOrder = async (transactionId: string, storeId: string): Promise<boolean> => {
    const client = await (db as any)._pool.connect();
    try {
        await client.query('BEGIN');

        const saleResult = await client.query(
            `SELECT s.*,
             COALESCE(json_agg(DISTINCT jsonb_build_object('productId', si.product_id, 'name', p.name, 'price', si.price_at_sale, 'quantity', si.quantity, 'costPrice', si.cost_at_sale)) FILTER (WHERE si.id IS NOT NULL), '[]') as cart
             FROM sales s
             LEFT JOIN sale_items si ON s.transaction_id = si.sale_id AND si.store_id = s.store_id
             LEFT JOIN products p ON si.product_id = p.id AND p.store_id = s.store_id
             WHERE s.transaction_id = $1 AND s.store_id = $2
             GROUP BY s.transaction_id`,
            [transactionId, storeId]
        );
        if (saleResult.rowCount === 0) { await client.query('ROLLBACK'); return false; }

        const sale = toCamelCase(saleResult.rows[0]);
        // Re-check inside the transaction — the owner may have fulfilled or
        // cancelled it between the batch scan and now.
        if (sale.fulfillmentStatus !== 'pending' || sale.paymentStatus !== 'unpaid') {
            await client.query('ROLLBACK');
            return false;
        }

        // Mirror the manual-cancel path: restock, reverse the customer's
        // balance, reverse the journal entry, then flag cancelled.
        for (const item of sale.cart) {
            await client.query(
                'UPDATE products SET stock = stock + $1 WHERE id = $2 AND store_id = $3',
                [item.quantity, item.productId, storeId]
            );
        }
        if (sale.customerId) {
            const balanceDue = Number(sale.total) - Number(sale.amountPaid || 0);
            if (balanceDue > 0) {
                await client.query(
                    'UPDATE customers SET account_balance = account_balance - $1 WHERE id = $2 AND store_id = $3',
                    [balanceDue, sale.customerId, storeId]
                );
            }
        }
        await accountingService.voidSale(sale, client, storeId);
        await client.query(
            `UPDATE sales SET fulfillment_status = 'cancelled' WHERE transaction_id = $1 AND store_id = $2`,
            [transactionId, storeId]
        );

        await client.query('COMMIT');

        // Best-effort notifications after commit. The buyer notification goes
        // to the linked ACCOUNT (customers.user_id), not the store-scoped
        // customer id, which is not a user.
        try {
            await pushService.sendToStore(storeId, {
                title: 'Online order auto-cancelled',
                body: `Order ${transactionId} was unpaid for ${EXPIRY_DAYS}+ days — cancelled and stock restored.`,
                url: '/pos/history',
            }, ['admin', 'staff', 'superadmin']);
            if (sale.customerId) {
                const userRes = await db.query(
                    `SELECT COALESCE(c.user_id, u.id) AS uid
                     FROM customers c LEFT JOIN users u ON u.id = c.id
                     WHERE c.id = $1 AND c.store_id = $2`,
                    [sale.customerId, storeId]
                );
                const uid = userRes.rows[0]?.uid;
                if (uid) {
                    await pushService.sendToUsers([uid], {
                        title: 'Order cancelled',
                        body: `Your order ${transactionId} was cancelled because it stayed unpaid. You can order again anytime.`,
                        url: '/marketplace?view=my-orders',
                    }, storeId);
                }
            }
        } catch (notifyErr) {
            console.error('[stale-orders] notification failed:', notifyErr);
        }

        return true;
    } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
    } finally {
        client.release();
    }
};

export const runStaleOrderCleanup = async (): Promise<number> => {
    // Scan cheaply, then cancel each order in its own transaction so one
    // poison row can't wedge the whole batch.
    const stale = await db.query(
        `SELECT transaction_id, store_id FROM sales
         WHERE channel = 'online' AND fulfillment_status = 'pending' AND payment_status = 'unpaid'
           AND "timestamp"::timestamptz < NOW() - make_interval(days => $1)
         ORDER BY "timestamp" ASC
         LIMIT 200`,
        [EXPIRY_DAYS]
    );

    let cancelled = 0;
    for (const row of stale.rows) {
        try {
            if (await cancelStaleOrder(row.transaction_id, row.store_id)) cancelled++;
        } catch (err) {
            console.error(`[stale-orders] failed to cancel ${row.transaction_id}:`, err);
        }
    }
    if (cancelled > 0) {
        console.log(`[stale-orders] Auto-cancelled ${cancelled} unpaid online orders older than ${EXPIRY_DAYS} day(s).`);
    }
    return cancelled;
};
