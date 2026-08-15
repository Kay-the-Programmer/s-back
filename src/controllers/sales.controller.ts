import express from 'express';
import db from '../db_client';
import { Sale, Payment } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';
import { notifyStoreOwner, sendTemplatedEmail } from '../services/email-template.service';
import LencoService from '../services/lenco.service';

import SocketService from '../services/socket.service';

export const getSales = async (req: express.Request, res: express.Response) => {
    const { startDate, endDate, customerId, paymentStatus } = req.query as { [key: string]: string };
    const pageNum = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const limitNum = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;

    // Enforce tenant context
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    let baseQuery = `
        FROM sales s
                 LEFT JOIN (
                     SELECT original_sale_id, SUM(refund_amount) as total_refunded 
                     FROM returns 
                     WHERE store_id = $1 
                     GROUP BY original_sale_id
                 ) ret ON s.transaction_id = ret.original_sale_id
                 LEFT JOIN sale_items si ON s.transaction_id = si.sale_id AND si.store_id = s.store_id
                 LEFT JOIN products p ON si.product_id = p.id AND p.store_id = s.store_id
                 LEFT JOIN payments pay ON s.transaction_id = pay.sale_id AND pay.store_id = s.store_id
    `;

    const params: any[] = [];
    const whereClauses: string[] = [];

    // Tenant boundary first
    params.push(storeId);
    whereClauses.push(`s.store_id = $${params.length}`);

    if (startDate) {
        params.push(startDate);
        whereClauses.push(`s.timestamp >= $${params.length}`);
    }
    if (endDate) {
        params.push(new Date(new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString());
        whereClauses.push(`s.timestamp <= $${params.length}`);
    }
    if (customerId) {
        params.push(customerId);
        whereClauses.push(`s.customer_id = $${params.length}`);
    }
    if (paymentStatus) {
        params.push(paymentStatus);
        whereClauses.push(`s.payment_status = $${params.length}`);
    }
    // Free-text search across the transaction id, the customer (linked record or
    // the snapshot on the sale) and the PRODUCTS sold. Product/customer matching
    // uses EXISTS rather than the joined aliases so the same clause is valid in
    // the count query, which only selects FROM sales.
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) {
        params.push(`%${search}%`);
        const term = `$${params.length}`;
        whereClauses.push(`(
            s.transaction_id ILIKE ${term}
            OR s.customer_details->>'name' ILIKE ${term}
            OR EXISTS (
                SELECT 1 FROM customers c2
                WHERE c2.id = s.customer_id AND c2.store_id = s.store_id AND c2.name ILIKE ${term}
            )
            OR EXISTS (
                SELECT 1 FROM sale_items si2
                JOIN products p2 ON p2.id = si2.product_id AND p2.store_id = si2.store_id
                WHERE si2.sale_id = s.transaction_id AND si2.store_id = s.store_id
                  AND (p2.name ILIKE ${term} OR p2.sku ILIKE ${term} OR p2.barcode ILIKE ${term})
            )
        )`);
    }

    const { fulfillmentStatus, channel } = req.query as { [key: string]: string };
    if (fulfillmentStatus) {
        params.push(fulfillmentStatus);
        whereClauses.push(`s.fulfillment_status = $${params.length}`);
    }
    if (channel) {
        params.push(channel);
        whereClauses.push(`s.channel = $${params.length}`);
    }

    if (whereClauses.length > 0) {
        baseQuery += ' WHERE ' + whereClauses.join(' AND ');
    }

    let selectQuery = `
        SELECT s.*,
               s.total as "originalTotal",
               COALESCE(ret.total_refunded, 0) as "totalRefunded",
               (s.total - COALESCE(ret.total_refunded, 0)) as total,
               (s.amount_paid - COALESCE(ret.total_refunded, 0)) as amount_paid,
               COALESCE(json_agg(DISTINCT jsonb_build_object('productId', si.product_id, 'name', p.name, 'price', si.price_at_sale, 'quantity', si.quantity, 'stock', p.stock, 'costPrice', si.cost_at_sale, 'returnedQuantity', si.returned_quantity)) FILTER (WHERE si.id IS NOT NULL), '[]') as cart,
               COALESCE(json_agg(DISTINCT pay.*) FILTER (WHERE pay.id IS NOT NULL), '[]') as payments
        ${baseQuery}
        GROUP BY s.transaction_id, ret.total_refunded
        ORDER BY s.timestamp DESC
    `;

    const usePagination = !!limitNum && limitNum! > 0;

    try {
        let total = 0;
        if (usePagination) {
            const countQuery = `SELECT COUNT(*) as count FROM sales s WHERE s.store_id = $1${whereClauses.length > 1 ? ' AND ' + whereClauses.slice(1).join(' AND ') : ''}`;
            const countResult = await db.query(countQuery, params);
            total = parseInt(countResult.rows[0].count, 10) || 0;
            const page = Math.max(1, pageNum || 1);
            const limit = limitNum!;
            const offset = (page - 1) * limit;
            selectQuery += ` LIMIT ${limit} OFFSET ${offset}`;
        } else {
            // Safety ceiling: without it this endpoint returned EVERY sale (with
            // carts and payments) — an unbounded payload that grows forever. The
            // newest 1000 sales cover all UI needs; period totals come from the
            // aggregate endpoints (/reports/dashboard, /accounting/summary).
            selectQuery += ' LIMIT 1000';
        }

        const result = await db.query(selectQuery, params);
        const rows = toCamelCase(result.rows);

        if (usePagination) {
            res.status(200).json({ items: rows, total, page: Math.max(1, pageNum || 1), limit: limitNum });
        } else {
            res.status(200).json(rows);
        }
    } catch (error) {
        console.error('Error fetching sales:', error);
        res.status(500).json({ message: 'Error fetching sales' });
    }
};


/**
 * Quick "Hustle Mode" sale — records freeform amounts with no catalogue
 * products. Server-side ensures per-store catch-all products exist (category is
 * nullable and price 0 is allowed via direct SQL, unlike the createProduct
 * controller), so it never depends on client product creation.
 */
export const createQuickSale = async (req: express.Request, res: express.Response) => {
    const client = await db._pool.connect();
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const { items, paymentMethod } = req.body as {
            items: { name: string; amount: number; type: 'sale' | 'service'; quantity?: number }[];
            paymentMethod?: string;
        };
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ message: 'No items provided' });
        }

        await client.query('BEGIN');

        // Ensure the per-store catch-all products exist (FK target for sale_items).
        const ensureProduct = async (sku: string, name: string): Promise<string> => {
            const found = await client.query('SELECT id FROM products WHERE sku = $1 AND store_id = $2 LIMIT 1', [sku, storeId]);
            if (found.rows[0]) return found.rows[0].id;
            const id = generateId('prod');
            await client.query(
                `INSERT INTO products (id, name, description, sku, price, cost_price, stock, status, store_id, image_urls)
                 VALUES ($1, $2, $3, $4, 0, 0, 0, 'active', $5, '{}')`,
                [id, name, 'Hustle Mode catch-all item', sku, storeId]
            );
            return id;
        };
        const saleProductId = await ensureProduct('HUSTLE-QUICK', 'Quick Sale');
        const serviceProductId = await ensureProduct('HUSTLE-SVC', 'Quick Service');

        const total = items.reduce((a, it) => a + (Number(it.amount) || 0) * (it.quantity || 1), 0);
        const transactionId = generateId('SALE');
        const timestamp = new Date().toISOString();

        await client.query(
            `INSERT INTO sales(transaction_id, "timestamp", customer_id, total, subtotal, tax, discount, store_credit_used, payment_status, amount_paid, due_date, refund_status, store_id, attended_by, attended_by_id)
             VALUES ($1, $2, NULL, $3, $3, 0, 0, 0, 'paid', $3, NULL, 'none', $4, $5, $6)`,
            [transactionId, timestamp, total, storeId, req.user?.name || null, req.user?.id || null]
        );

        const cart: any[] = [];
        for (const it of items) {
            const pid = it.type === 'service' ? serviceProductId : saleProductId;
            const qty = it.quantity || 1;
            const price = Number(it.amount) || 0;
            await client.query(
                'INSERT INTO sale_items(sale_id, product_id, quantity, price_at_sale, cost_at_sale, store_id) VALUES ($1, $2, $3, $4, 0, $5)',
                [transactionId, pid, qty, price, storeId]
            );
            cart.push({ productId: pid, name: it.name, sku: it.type === 'service' ? 'HUSTLE-SVC' : 'HUSTLE-QUICK', price, quantity: qty, costPrice: 0 });
        }

        const payId = generateId('pay');
        await client.query(
            'INSERT INTO payments(id, sale_id, date, amount, method, reference, store_id) VALUES ($1, $2, $3, $4, $5, NULL, $6)',
            [payId, transactionId, timestamp, total, paymentMethod || 'Cash', storeId]
        );

        // Best-effort accounting — isolated by a savepoint so a books failure
        // never blocks recording the sale.
        await client.query('SAVEPOINT acc');
        try {
            await accountingService.recordSale(
                { transactionId, timestamp, total, subtotal: total, tax: 0, discount: 0, paymentStatus: 'paid', amountPaid: total, storeCreditUsed: 0, cart } as any,
                client, storeId
            );
        } catch (accErr) {
            await client.query('ROLLBACK TO SAVEPOINT acc');
            console.error('Quick sale accounting skipped:', accErr);
        }

        try { await auditService.log(req.user!, 'Quick Sale', `Transaction ID: ${transactionId}, Total: ${Number(total).toFixed(2)}`, client); } catch { /* non-fatal */ }

        await client.query('COMMIT');

        res.status(201).json({
            transactionId, timestamp, total, subtotal: total, tax: 0, discount: 0,
            paymentStatus: 'paid', amountPaid: total, refundStatus: 'none', channel: 'pos',
            cart, payments: [{ id: payId, amount: total, method: paymentMethod || 'Cash', date: timestamp }],
        });
    } catch (error: any) {
        try { await client.query('ROLLBACK'); } catch { /* ignore */ }
        console.error('Quick sale error:', error);
        res.status(500).json({ message: 'Failed to record quick sale' });
    } finally {
        client.release();
    }
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export const createSale = async (req: express.Request, res: express.Response) => {
    const client = await db._pool.connect();
    const { payments, ...saleData } = req.body as Sale;
    // Offline-first clients (desktop app, queued web sales) key their local
    // records — and later returns — by a client-generated transactionId, so a
    // stable client id is honored. The web app's "temp_*" placeholders and
    // anything unsafe fall back to a server-minted id.
    const clientTxId = typeof saleData.transactionId === 'string' ? saleData.transactionId.trim() : '';
    const transactionId = /^(?!temp_)[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/.test(clientTxId)
        ? clientTxId
        : generateId(saleData.paymentStatus === 'unpaid' ? 'INV' : 'SALE');
    // Offline sales sync hours or days after the fact, and a store moving off
    // paper books enters months of history by hand; reports must attribute both
    // to when the sale happened, not when it was typed. Client timestamps are
    // trusted within [-3y, +5min] of server time — the future stays closed so a
    // wrong date can't park revenue in a period that hasn't happened.
    const nowMs = Date.now();
    const clientTsMs = Date.parse(String(saleData.timestamp || ''));
    const BACKDATE_LIMIT_MS = 3 * 365 * 24 * 60 * 60 * 1000;
    const timestamp = Number.isFinite(clientTsMs)
        && clientTsMs <= nowMs + 5 * 60 * 1000
        && clientTsMs >= nowMs - BACKDATE_LIMIT_MS
        ? new Date(clientTsMs).toISOString()
        : new Date().toISOString();

    // Enforce tenant context
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        client.release();
        return res.status(400).json({ message: 'Store context required' });
    }

    if (!Array.isArray(saleData.cart) || saleData.cart.length === 0) {
        client.release();
        return res.status(400).json({ message: 'Cart is empty.' });
    }

    // Note: duplicate-request protection (X-Idempotency-Key) is handled globally
    // by the idempotency middleware, which replays the cached response for a
    // retried mutation. Nothing sale-specific is needed here.

    try {
        // --- Authoritative totals: recomputed server-side from the cart. ---
        // The client's arithmetic is only trusted when it is internally consistent;
        // otherwise the server's figures win. This is the single point where money
        // enters the system, so nothing downstream has to re-derive or repair it.
        const cartSubtotal = round2(saleData.cart.reduce((a, i) => a + (Number(i.price) || 0) * (Number(i.quantity) || 0), 0));
        const discount = round2(Math.min(Math.max(Number(saleData.discount) || 0, 0), cartSubtotal));

        let storeCreditUsed = round2(Math.max(Number(saleData.storeCreditUsed) || 0, 0));
        if (storeCreditUsed > 0) {
            if (!saleData.customerId) {
                storeCreditUsed = 0;
            } else {
                const custRes = await db.query('SELECT store_credit FROM customers WHERE id = $1 AND store_id = $2', [saleData.customerId, storeId]);
                const available = custRes.rowCount ? Math.max(0, Number(custRes.rows[0].store_credit) || 0) : 0;
                storeCreditUsed = round2(Math.min(storeCreditUsed, available));
            }
        }

        // Tax: accept the client's figure when the claimed total adds up exactly
        // (allows tax-exempt sales and offline sales made under an older rate);
        // otherwise recompute from the store's configured rate.
        const clientTax = round2(Math.max(Number(saleData.tax) || 0, 0));
        const claimedTotal = round2(Number(saleData.total) || 0);
        let tax: number;
        if (Math.abs(claimedTotal - round2(cartSubtotal - discount + clientTax - storeCreditUsed)) <= 0.02) {
            tax = clientTax;
        } else {
            const settingsRes = await db.query('SELECT tax_rate FROM store_settings WHERE store_id = $1', [storeId]);
            const taxRatePct = settingsRes.rowCount ? Number(settingsRes.rows[0].tax_rate) || 0 : 0;
            tax = round2((cartSubtotal - discount) * (taxRatePct / 100));
        }
        const total = round2(cartSubtotal - discount + tax - storeCreditUsed);

        const paymentStatus: Sale['paymentStatus'] = saleData.paymentStatus || 'paid';
        const amountPaid = paymentStatus === 'paid'
            ? total
            : round2(Math.min(Math.max(Number(saleData.amountPaid) || 0, 0), total));

        // Overwrite the client-sent figures with the authoritative ones so every
        // downstream consumer (accounting, customer balance, response) agrees.
        saleData.subtotal = cartSubtotal;
        saleData.discount = discount;
        saleData.tax = tax;
        saleData.total = total;
        saleData.storeCreditUsed = storeCreditUsed;
        saleData.amountPaid = amountPaid;
        if (saleData.cashReceived != null) {
            saleData.changeDue = round2(Math.max(0, Number(saleData.cashReceived) - total));
        }

        await client.query('BEGIN');

        // --- Customer phone capture: automatically save numbers collected at
        // the POS (explicit entry or the mobile-money number). If no customer
        // is attached, find-or-create one by phone so repeat buyers accumulate
        // history under a single record.
        const phoneDigits = String(saleData.customerPhone || '').replace(/\D/g, '');
        let resolvedCustomerName: string | undefined = saleData.customerName;
        if (phoneDigits.length >= 7) {
            if (saleData.customerId) {
                // Attach the number to the selected customer if they don't have one yet.
                await client.query(
                    `UPDATE customers SET phone = $1 WHERE id = $2 AND store_id = $3 AND (phone IS NULL OR phone = '')`,
                    [saleData.customerPhone, saleData.customerId, storeId]
                );
            } else {
                const existing = await client.query(
                    `SELECT id, name FROM customers WHERE store_id = $2 AND regexp_replace(COALESCE(phone, ''), '\\D', '', 'g') = $1 LIMIT 1`,
                    [phoneDigits, storeId]
                );
                if (existing.rowCount) {
                    saleData.customerId = existing.rows[0].id;
                    resolvedCustomerName = existing.rows[0].name;
                } else {
                    const newCustomerId = generateId('cus');
                    const newCustomerName = saleData.customerName?.trim() || `Customer ${saleData.customerPhone}`;
                    await client.query(
                        `INSERT INTO customers (id, name, phone, created_at, store_credit, account_balance, store_id)
                         VALUES ($1, $2, $3, $4, 0, 0, $5)`,
                        [newCustomerId, newCustomerName, saleData.customerPhone, timestamp, storeId]
                    );
                    saleData.customerId = newCustomerId;
                    resolvedCustomerName = newCustomerName;
                }
            }
        }

        // Cashier attribution ("Attended by" on receipts) — stamped from the
        // authenticated user, never trusted from the client payload.
        const attendedBy = req.user?.name || null;
        const attendedById = req.user?.id || null;

        const saleQuery = `
            INSERT INTO sales(transaction_id, "timestamp", customer_id, total, subtotal, tax, discount, store_credit_used, payment_status, amount_paid, due_date, refund_status, store_id, attended_by, attended_by_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *;
        `;
        const saleResult = await client.query(saleQuery, [
            transactionId, timestamp, saleData.customerId, total, cartSubtotal, tax,
            discount, storeCreditUsed, paymentStatus, amountPaid, saleData.dueDate, 'none', storeId,
            attendedBy, attendedById
        ]);
        const newSale = saleResult.rows[0];

        const productIds = saleData.cart.map(i => i.productId);
        const productsResult = await client.query('SELECT id, name, cost_price, stock, reorder_point FROM products WHERE id = ANY($1::text[]) AND store_id = $2', [productIds, storeId]);
        const productMap = new Map<string, any>(productsResult.rows.map((p: any) => [p.id, p]));

        for (const item of saleData.cart) {
            const product = productMap.get(item.productId);
            const currentCostPrice = parseFloat(product?.cost_price || 0);

            await client.query(
                'INSERT INTO sale_items(sale_id, product_id, quantity, price_at_sale, cost_at_sale, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [transactionId, item.productId, item.quantity, item.price, currentCostPrice, storeId]
            );

            // Decrement RELATIVELY and take the new level from the database.
            // Computing `stock - qty` in JS from an unlocked SELECT lost a whole
            // sale's worth of stock whenever two tills sold the same product at
            // once: both read the same level, both wrote an absolute value, and
            // the second write silently erased the first — leaving inventory
            // permanently overstated. `stock = stock - $1` re-reads the row under
            // the row lock, so concurrent sales compose.
            const stockResult = await client.query(
                'UPDATE products SET stock = stock - $1 WHERE id = $2 AND store_id = $3 RETURNING stock',
                [item.quantity, item.productId, storeId]
            );
            const newStock = parseFloat(stockResult.rows[0]?.stock ?? '0');

            if (product.reorder_point !== null && newStock <= parseFloat(product.reorder_point)) {
                try {
                    const title = "Low Stock Alert ⚠️";
                    const message = `Low stock: ${product.name} (${newStock} left). Reorder at: ${product.reorder_point}.`;

                    const { pushService } = await import('../services/push.service');
                    await pushService.sendToStore(storeId, {
                        title: title,
                        body: message,
                        url: `/inventory`
                    }, ['admin', 'inventory_manager', 'staff']);

                    // --- Trigger Low Stock Email (configurable engine) ---
                    await notifyStoreOwner('LOW_STOCK_ALERT', storeId, {
                        productName: product.name,
                        currentStock: newStock,
                        reorderPoint: parseFloat(product.reorder_point),
                    });
                    // --------------------------------
                } catch (e) { console.error('Low stock notification failed', e); }
            }

            item.costPrice = currentCostPrice;
        }

        const finalPayments = [] as any[];
        if (payments) {
            for (const payment of payments) {
                // Server-side double-check for Lenco payments
                if (payment.method.toLowerCase().includes('lenco') && payment.reference?.startsWith('ref-')) {
                    try {
                        const verification = await LencoService.verifyTransaction(payment.reference);
                        if (!verification.status || verification.data.status !== 'successful') {
                            throw new Error(`Lenco verification failed for ${payment.reference}`);
                        }
                    } catch (err: any) {
                        throw new Error(`Payment verification failed: ${err.message}`);
                    }
                }

                const paymentId = generateId('pay');
                const pResult = await client.query(
                    'INSERT INTO payments(id, sale_id, date, amount, method, reference, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *',
                    [paymentId, transactionId, timestamp, payment.amount, payment.method, payment.reference, storeId]
                );
                finalPayments.push(pResult.rows[0]);
            }
        }

        if (saleData.customerId) {
            let balanceUpdateQuery = 'UPDATE customers SET ';
            const updates: string[] = [];
            const params: any[] = [];
            if (saleData.storeCreditUsed && saleData.storeCreditUsed > 0) {
                params.push(saleData.storeCreditUsed);
                updates.push(`store_credit = store_credit - $${params.length}`);
            }
            if (saleData.paymentStatus !== 'paid') {
                const amountPaid = Number(saleData.amountPaid || 0);
                const unpaidAmount = Number(saleData.total) - amountPaid;
                if (unpaidAmount > 0.001) {
                    params.push(unpaidAmount);
                    updates.push(`account_balance = account_balance + $${params.length}`);
                }
            }
            if (updates.length > 0) {
                params.push(saleData.customerId);
                params.push(storeId);
                balanceUpdateQuery += updates.join(', ') + ` WHERE id = $${params.length - 1} AND store_id = $${params.length}`;
                await client.query(balanceUpdateQuery, params);
            }
        }

        await auditService.log(req.user!, 'Sale Created', `Transaction ID: ${transactionId}, Total: ${Number(saleData.total).toFixed(2)}`, client);
        await accountingService.recordSale(toCamelCase({ ...newSale, cart: saleData.cart }), client, storeId);

        await client.query('COMMIT');

        const saleResponse = toCamelCase({
            ...newSale,
            customer_name: resolvedCustomerName || null,
            customer_phone: saleData.customerPhone || null,
            cart: saleData.cart,
            payments: finalPayments
        });

        // --- Push Notification for New Sale ---
        try {
            const { pushService } = await import('../services/push.service');
            await pushService.sendToStore(storeId, {
                title: 'New Sale Created! 💰',
                body: `Transaction ${transactionId} for ${Number(saleData.total).toFixed(2)}`,
                url: `/sales/history`
            }, ['admin', 'staff', 'superadmin']);
        } catch (pushError) {
            console.error('Failed to send push notification for new sale:', pushError);
        }
        // --------------------------------------

        // --- Order Confirmation email to the customer (configurable engine) ---
        if (saleData.customerId) {
            try {
                const customerResult = await db.query('SELECT email, name FROM customers WHERE id = $1 AND store_id = $2', [saleData.customerId, storeId]);
                if (customerResult.rowCount && customerResult.rows[0].email) {
                    const customer = customerResult.rows[0];
                    // The store name + currency are resolved by the engine's owner
                    // helper; here the recipient is the customer, so pass them.
                    const settingsRes = await db.query('SELECT name, currency FROM store_settings WHERE store_id = $1', [storeId]);
                    await sendTemplatedEmail('ORDER_CONFIRMATION', customer.email, {
                        storeName: settingsRes.rows[0]?.name || 'your store',
                        currency: settingsRes.rows[0]?.currency?.symbol || 'K',
                        userName: customer.name || 'Customer',
                        transactionId,
                        total: saleData.total,
                    });
                }
            } catch (emailError) {
                console.error('Failed to trigger order confirmation email:', emailError);
            }
        }
        // ----------------------------------------------------

        // Broadcast to store room for real-time updates
        try {
            SocketService.getInstance().emitToStore(storeId, 'new_sale', saleResponse);
        } catch (socketError) {
            console.error('Failed to broadcast new sale via socket:', socketError);
        }

        res.status(201).json(saleResponse);

    } catch (error: any) {
        await client.query('ROLLBACK');
        // A client-supplied transactionId that already exists means this sale
        // was already recorded (e.g. a retry whose idempotency cache expired) —
        // signal "already there" rather than a retryable server failure.
        if (error?.code === '23505' && String(error?.constraint || '').startsWith('sales_')) {
            return res.status(409).json({ message: 'A sale with this transactionId already exists.', transactionId });
        }
        console.error('Error creating sale:', error);
        res.status(500).json({ message: 'Failed to create sale' });
    } finally {
        client.release();
    }
};


export const recordPayment = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const paymentData: Omit<Payment, 'id'> = req.body;

    // `payments.date` is NOT NULL, and a caller settling an invoice has no
    // reason to send one — the payment is happening now. Without this default
    // the insert failed with a raw constraint violation and the money was never
    // recorded, leaving the customer still owing the full amount.
    if (!paymentData.date) {
        paymentData.date = new Date().toISOString();
    }
    if (!(Number(paymentData.amount) > 0)) {
        return res.status(400).json({ message: 'A payment amount greater than zero is required.' });
    }

    // Enforce tenant context
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    const client = await db._pool.connect();
    try {
        await client.query('BEGIN');

        const saleResult = await client.query('SELECT * FROM sales WHERE transaction_id = $1 AND store_id = $2', [id, storeId]);
        if (saleResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Sale not found' });
        }
        const sale = saleResult.rows[0];

        const totalCents = Math.round(sale.total * 100);
        const alreadyPaidCents = Math.round(sale.amount_paid * 100);
        const remainingCents = Math.max(0, totalCents - alreadyPaidCents);
        const paymentCents = Math.round(paymentData.amount * 100);

        // Block payments when invoice is already fully paid
        if (remainingCents <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Invoice is already fully paid. No additional payments are allowed.' });
        }
        // Prevent overpayments beyond the remaining balance (allowing for cent rounding)
        if (paymentCents > remainingCents) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Payment exceeds remaining balance. Remaining due is ${(remainingCents / 100).toFixed(2)}.` });
        }

        const newAmountPaid = Number(sale.amount_paid) + Number(paymentData.amount);
        const paidCents = Math.round(newAmountPaid * 100);
        const newPaymentStatus = paidCents >= totalCents ? 'paid' : 'partially_paid';

        await client.query(
            'INSERT INTO payments(id, sale_id, date, amount, method, reference, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [generateId('pay'), id, paymentData.date, paymentData.amount, paymentData.method, paymentData.reference, storeId]
        );

        const updatedSaleResult = await client.query(
            'UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE transaction_id = $3 AND store_id = $4 RETURNING *',
            [newAmountPaid, newPaymentStatus, id, storeId]
        );

        if (sale.customer_id) {
            await client.query(
                'UPDATE customers SET account_balance = account_balance - $1 WHERE id = $2 AND store_id = $3',
                [paymentData.amount, sale.customer_id, storeId]
            );
        }

        await auditService.log(req.user!, 'Payment Recorded', `For Invoice ${id}, Amount: ${Number(paymentData.amount).toFixed(2)}`, client);
        await accountingService.recordCustomerPayment(toCamelCase(sale), { ...paymentData, id: '' }, client, storeId);

        await client.query('COMMIT');
        res.status(200).json(toCamelCase(updatedSaleResult.rows[0]));

    } catch (error: any) {
        await client.query('ROLLBACK');
        console.error('Error recording payment:', error);
        res.status(500).json({ message: 'Failed to record payment', error: error.message });
    } finally {
        client.release();
    }
};

/**
 * Correct the DATE of an existing sale — nothing else.
 *
 * A store typing up paper books gets the day wrong, or rings a sale on the
 * following morning. Moving the sale means moving everything that reports off
 * it, or the figures disagree: the sale row itself, the payment rows that were
 * stamped when it was rung, and the journal entry behind the books. All three
 * move in one transaction, so a report can never see a half-moved sale.
 *
 * Deliberately narrow: totals, lines, payment method and customer are all left
 * alone. Re-pricing a historical sale is a different (and much riskier) feature.
 */
export const updateSaleDate = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { timestamp } = req.body as { timestamp?: string };

    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    // Same window the create path trusts: up to three years back for book
    // catch-up, never the future.
    const nowMs = Date.now();
    const parsedMs = Date.parse(String(timestamp || ''));
    if (!Number.isFinite(parsedMs)) {
        return res.status(400).json({ message: 'A valid date is required.' });
    }
    if (parsedMs > nowMs + 5 * 60 * 1000) {
        return res.status(400).json({ message: 'A sale cannot be dated in the future.' });
    }
    if (parsedMs < nowMs - 3 * 365 * 24 * 60 * 60 * 1000) {
        return res.status(400).json({ message: 'That date is more than three years ago.' });
    }
    const nextTimestamp = new Date(parsedMs).toISOString();

    const client = await db._pool.connect();
    try {
        await client.query('BEGIN');

        const existing = await client.query(
            'SELECT transaction_id, "timestamp" FROM sales WHERE transaction_id = $1 AND store_id = $2 FOR UPDATE',
            [id, storeId],
        );
        if (existing.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Sale not found' });
        }
        const previousTimestamp = new Date(existing.rows[0].timestamp).toISOString();

        // Payments FIRST, and matched against the sale's stored timestamp rather
        // than a round-tripped string: a JS Date carries milliseconds, the column
        // can hold microseconds, so comparing to `previousTimestamp` would match
        // nothing for any sale whose time came from the database.
        // Only the payments taken AT the sale move with it — a part-payment
        // collected later has its own date and keeps it.
        await client.query(
            `UPDATE payments SET date = $1
             WHERE sale_id = $2 AND store_id = $3
               AND date = (SELECT "timestamp" FROM sales WHERE transaction_id = $2 AND store_id = $3)`,
            [nextTimestamp, id, storeId],
        );

        await client.query(
            'UPDATE sales SET "timestamp" = $1 WHERE transaction_id = $2 AND store_id = $3',
            [nextTimestamp, id, storeId],
        );

        // The books follow the sale, otherwise the P&L and cash-flow reports
        // (which read journal_entries.date) would still show the old day.
        await client.query(
            `UPDATE journal_entries SET date = $1
             WHERE store_id = $2 AND source_type = 'sale' AND source_id = $3`,
            [nextTimestamp, storeId, id],
        );

        const updated = await client.query(
            'SELECT * FROM sales WHERE transaction_id = $1 AND store_id = $2',
            [id, storeId],
        );

        await client.query('COMMIT');

        await auditService.log(
            req.user!,
            'Sale Date Changed',
            `Sale: ${id} | From: ${previousTimestamp} To: ${nextTimestamp}`,
        );

        return res.status(200).json(toCamelCase(updated.rows[0]));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error(`Error updating date for sale ${id}:`, error);
        return res.status(500).json({ message: 'Error updating the sale date' });
    } finally {
        client.release();
    }
};

export const updateFulfillmentStatus = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { status } = req.body; // pending, fulfilled, shipped, cancelled

    const validStatuses = ['pending', 'accepted', 'fulfilled', 'shipped', 'cancelled'];
    if (!validStatuses.includes(status)) {
        return res.status(400).json({ message: 'Invalid fulfillment status' });
    }

    // Enforce tenant context
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    try {
        const client = await db._pool.connect();
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
                [id, storeId]
            );

            if (saleResult.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Sale not found' });
            }

            const sale = toCamelCase(saleResult.rows[0]);

            if (sale.fulfillmentStatus === 'cancelled') {
                await client.query('ROLLBACK');
                return res.status(400).json({ message: 'Order is already cancelled' });
            }

            if (status === 'cancelled') {
                for (const item of sale.cart) {
                    await client.query(
                        'UPDATE products SET stock = stock + $1 WHERE id = $2 AND store_id = $3',
                        [item.quantity, item.productId, storeId]
                    );
                }

                if (sale.customerId && sale.paymentStatus !== 'paid') {
                    const balanceDue = Number(sale.total) - Number(sale.amountPaid || 0);
                    if (balanceDue > 0) {
                        await client.query(
                            'UPDATE customers SET account_balance = account_balance - $1 WHERE id = $2 AND store_id = $3',
                            [balanceDue, sale.customerId, storeId]
                        );
                    }
                }

                await accountingService.voidSale(sale, client, storeId);
            }

            const result = await client.query(
                'UPDATE sales SET fulfillment_status = $1 WHERE transaction_id = $2 AND store_id = $3 RETURNING *',
                [status, id, storeId]
            );

            // Send Push Notification to Customer — resolve the ACCOUNT id:
            // customer records are store-scoped (cus-…) and link to the user
            // via customers.user_id (legacy rows reused the user id directly).
            if (sale.customerId) {
                try {
                    const uidRes = await client.query(
                        `SELECT COALESCE(c.user_id, u.id) AS uid
                         FROM customers c LEFT JOIN users u ON u.id = c.id
                         WHERE c.id = $1 AND c.store_id = $2`,
                        [sale.customerId, storeId]
                    );
                    const buyerUserId = uidRes.rows[0]?.uid;
                    if (!buyerUserId) throw new Error('no linked user account');
                    const { pushService } = await import('../services/push.service');
                    let statusMsg = `Your order ${id} is now ${status}!`;
                    if (status === 'accepted') statusMsg = `The store accepted your order ${id} and is preparing it. 👍`;
                    if (status === 'shipped') statusMsg = `Great news! Your order ${id} has been shipped. 🚚`;
                    if (status === 'fulfilled') statusMsg = `Your order ${id} has been fulfilled and is ready. ✅`;
                    if (status === 'cancelled') statusMsg = `Your order ${id} has been cancelled. ℹ️`;

                    await pushService.sendToUsers([buyerUserId], {
                        title: 'Order Update',
                        body: statusMsg,
                        url: `/marketplace/orders` // or relevant tracking page
                    });
                } catch (pushErr) {
                    console.error('Failed to send fulfillment push notification:', pushErr);
                }
            }

            await auditService.log(
                req.user!,
                'Update Order Status',
                `Transaction ${id} status changed from ${sale.fulfillmentStatus} to ${status}`,
                client
            );

            await client.query('COMMIT');
            res.json(toCamelCase(result.rows[0]));
        } catch (innerError) {
            await client.query('ROLLBACK');
            throw innerError;
        } finally {
            client.release();
        }
    } catch (error) {
        console.error('Error updating fulfillment status:', error);
        res.status(500).json({ message: 'Error updating status' });
    }
};