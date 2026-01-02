import express from 'express';
import db from '../db_client';
import { Sale, Payment } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';

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
                 LEFT JOIN sale_items si ON s.transaction_id = si.sale_id
                 LEFT JOIN products p ON si.product_id = p.id
                 LEFT JOIN payments pay ON s.transaction_id = pay.sale_id
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

    if (whereClauses.length > 0) {
        baseQuery += ' WHERE ' + whereClauses.join(' AND ');
    }

    let selectQuery = `
        SELECT s.*,
               COALESCE(json_agg(DISTINCT jsonb_build_object('productId', si.product_id, 'name', p.name, 'price', si.price_at_sale, 'quantity', si.quantity, 'stock', p.stock, 'costPrice', si.cost_at_sale, 'returnedQuantity', 0)) FILTER (WHERE si.id IS NOT NULL), '[]') as cart,
               COALESCE(json_agg(DISTINCT pay.*) FILTER (WHERE pay.id IS NOT NULL), '[]') as payments
        ${baseQuery}
        GROUP BY s.transaction_id
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

        for (const item of saleData.cart) {
            await client.query(
                'INSERT INTO sale_items(sale_id, product_id, quantity, price_at_sale, cost_at_sale, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [transactionId, item.productId, item.quantity, item.price, item.costPrice, storeId]
            );
            await client.query(
                'UPDATE products SET stock = stock - $1 WHERE id = $2 AND store_id = $3',
                [item.quantity, item.productId, storeId]
            );
        }

        const finalPayments = [] as any[];
        if (payments) {
            for (const payment of payments) {
                const paymentId = generateId('pay');
                const pResult = await client.query(
                    'INSERT INTO payments(id, sale_id, date, amount, method, store_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
                    [paymentId, transactionId, timestamp, payment.amount, payment.method, storeId]
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
                params.push(saleData.total);
                updates.push(`account_balance = account_balance + $${params.length}`);
            }
            if (updates.length > 0) {
                params.push(saleData.customerId);
                params.push(storeId);
                balanceUpdateQuery += updates.join(', ') + ` WHERE id = $${params.length - 1} AND store_id = $${params.length}`;
                await client.query(balanceUpdateQuery, params);
            }
        }

        await auditService.log(req.user!, 'Sale Created', `Transaction ID: ${transactionId}, Total: ${saleData.total.toFixed(2)}`, client);
        await accountingService.recordSale({ ...newSale, cart: saleData.cart }, client, storeId);

        await client.query('COMMIT');

        res.status(201).json(toCamelCase({ ...newSale, cart: saleData.cart, payments: finalPayments }));

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
            return res.status(400).json({ message: `Payment exceeds remaining balance. Remaining due is ${(remainingCents/100).toFixed(2)}.` });
        }

        const newAmountPaid = sale.amount_paid + paymentData.amount;
        const paidCents = Math.round(newAmountPaid * 100);
        const newPaymentStatus = paidCents >= totalCents ? 'paid' : 'partially_paid';

        await client.query(
            'INSERT INTO payments(id, sale_id, date, amount, method, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [generateId('pay'), id, paymentData.date, paymentData.amount, paymentData.method, storeId]
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

        await auditService.log(req.user!, 'Payment Recorded', `For Invoice ${id}, Amount: ${paymentData.amount.toFixed(2)}`, client);
        await accountingService.recordCustomerPayment(sale, { ...paymentData, id: '' }, client, storeId);

        await client.query('COMMIT');
        res.status(200).json(toCamelCase(updatedSaleResult.rows[0]));

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording payment:', error);
        res.status(500).json({ message: 'Failed to record payment' });
    } finally {
        client.release();
    }
};