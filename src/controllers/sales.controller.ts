import express from 'express';
import db from '../db_client';
import { Sale, Payment } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';
import LencoService from '../services/lenco.service';

import SocketService from '../services/socket.service';
import { adminDb } from '../firebase';

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


export const createSale = async (req: express.Request, res: express.Response) => {
    const client = await db._pool.connect();
    const { payments, ...saleData } = req.body as Sale;
    const transactionId = generateId(saleData.paymentStatus === 'unpaid' ? 'INV' : 'SALE');
    const timestamp = new Date().toISOString();

    // Enforce tenant context
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    try {
        await client.query('BEGIN');

        const saleQuery = `
            INSERT INTO sales(transaction_id, "timestamp", customer_id, total, subtotal, tax, discount, store_credit_used, payment_status, amount_paid, due_date, refund_status, store_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *;
        `;
        const saleResult = await client.query(saleQuery, [
            transactionId, timestamp, saleData.customerId, saleData.total, saleData.subtotal, saleData.tax,
            saleData.discount, saleData.storeCreditUsed, saleData.paymentStatus, saleData.amountPaid, saleData.dueDate, 'none', storeId
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

            const newStock = parseFloat(product.stock) - item.quantity;
            await client.query(
                'UPDATE products SET stock = $1 WHERE id = $2 AND store_id = $3',
                [newStock, item.productId, storeId]
            );

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

                    // --- Trigger Low Stock Email ---
                    if (adminDb) {
                        try {
                            const storeResult = await db.query('SELECT owner_id FROM stores WHERE id = $1', [storeId]);
                            if (storeResult.rowCount && storeResult.rows[0].owner_id) {
                                const ownerRes = await db.query('SELECT email, name FROM users WHERE id = $1', [storeResult.rows[0].owner_id]);
                                if (ownerRes.rowCount && ownerRes.rows[0].email) {
                                    await adminDb.collection('mail_events').add({
                                        type: 'LOW_STOCK_ALERT',
                                        storeId,
                                        userEmail: ownerRes.rows[0].email,
                                        userName: ownerRes.rows[0].name,
                                        productName: product.name,
                                        currentStock: newStock,
                                        reorderPoint: parseFloat(product.reorder_point),
                                        timestamp: new Date().toISOString()
                                    });
                                }
                            }
                        } catch (emailErr) {
                            console.error('Failed to trigger low stock email:', emailErr);
                        }
                    }
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

        const saleResponse = toCamelCase({ ...newSale, cart: saleData.cart, payments: finalPayments });

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

        // --- Trigger Email Extension for Order Confirmation ---
        if (saleData.customerId && adminDb) {
            try {
                const customerResult = await db.query('SELECT email, name FROM customers WHERE id = $1 AND store_id = $2', [saleData.customerId, storeId]);
                if (customerResult.rowCount && customerResult.rowCount > 0 && customerResult.rows[0].email) {
                    const customer = customerResult.rows[0];

                    // Add to mail_events for structured template processing
                    await adminDb.collection('mail_events').add({
                        type: 'ORDER_CONFIRMATION',
                        storeId,
                        transactionId,
                        userEmail: customer.email,
                        userName: customer.name || 'Customer',
                        total: saleData.total,
                        cart: saleData.cart,
                        timestamp: new Date().toISOString()
                    });
                    console.log(`Added order confirmation event for ${transactionId} to Firestore.`);
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

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating sale:', error);
        res.status(500).json({ message: 'Failed to create sale' });
    } finally {
        client.release();
    }
};


export const recordPayment = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const paymentData: Omit<Payment, 'id'> = req.body;

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

export const updateFulfillmentStatus = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { status } = req.body; // pending, fulfilled, shipped, cancelled

    const validStatuses = ['pending', 'fulfilled', 'shipped', 'cancelled'];
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

            // Send Push Notification to Customer
            if (sale.customerId) {
                try {
                    const { pushService } = await import('../services/push.service');
                    let statusMsg = `Your order ${id} is now ${status}!`;
                    if (status === 'shipped') statusMsg = `Great news! Your order ${id} has been shipped. 🚚`;
                    if (status === 'fulfilled') statusMsg = `Your order ${id} has been fulfilled and is ready. ✅`;
                    if (status === 'cancelled') statusMsg = `Your order ${id} has been cancelled. ℹ️`;

                    await pushService.sendToUsers([sale.customerId], {
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