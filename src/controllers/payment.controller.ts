import { Request, Response, NextFunction } from 'express';
import LencoService from '../services/lenco.service';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';

/**
 * Helper to fetch store's Lenco secret key
 */
const getStoreLencoKey = async (storeId: string): Promise<string | undefined> => {
    try {
        const result = await db.query('SELECT lenco_secret_key FROM store_settings WHERE store_id = $1', [storeId]);
        return result.rows[0]?.lenco_secret_key || undefined;
    } catch (error) {
        console.error(`Error fetching Lenco key for store ${storeId}:`, error);
        return undefined;
    }
};

/**
 * Verify a Lenco payment transaction
 * POST /api/payments/lenco/verify
 * Body: { reference: string }
 */
export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
    const { reference } = req.body;
    try {
        const storeId = (req as any).tenant?.storeId || (req as any).user?.currentStoreId;
        if (!storeId) {
            res.status(400).json({ status: false, message: 'Store context is required' });
            return;
        }

        if (!reference) {
            res.status(400).json({ status: false, message: 'Reference is required' });
            return;
        }

        const lencoSecretKey = await getStoreLencoKey(storeId);

        console.log(`Verifying Lenco payment: ${reference} for store ${storeId}`);
        const transaction = await LencoService.verifyTransaction(reference, lencoSecretKey);

        const lencoStatus = transaction.data?.status;

        if (transaction.status && lencoStatus === 'successful') {
            console.log(`Lenco payment SUCCESS: ${reference}`);
            res.status(200).json({
                status: true,
                message: 'Payment verified successfully',
                data: transaction.data,
            });
        } else if (transaction.status && lencoStatus !== 'failed') {
            // Treat everything else (pending, sent, initiated, accepted, otp-required) as pending
            console.log(`Lenco payment PENDING (${lencoStatus}): ${reference}`);
            res.status(200).json({
                status: true,
                pending: true,
                message: `Payment status: ${lencoStatus || 'processing'}`,
                data: transaction.data,
            });
        } else {
            console.warn(`Lenco payment FAILED or NOT FOUND: ${reference}`, transaction);
            res.status(200).json({
                status: false,
                message: transaction.message || (transaction.data?.reasonForFailure) || `Payment ${lencoStatus || 'failed'}`,
                data: transaction.data,
                errorCode: transaction.errorCode
            });
        }
    } catch (error: any) {
        console.error(`Lenco verification ERROR: ${reference}`, error);

        // If the error has a status: false (from LencoService throwing error.response.data)
        if (error.status === false) {
            res.status(200).json({
                status: false,
                message: error.message || 'Lenco verification failed',
                data: error.data || null,
                errorCode: error.errorCode
            });
            return;
        }

        res.status(400).json({
            status: false,
            message: error.message || 'An unexpected error occurred during verification'
        });
    }
};

/**
 * Get banks list
 * GET /api/payments/lenco/banks
 * Query: ?country=zm (optional)
 */
export const getBanks = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const storeId = (req as any).tenant?.storeId || (req as any).user?.currentStoreId;
        const lencoSecretKey = storeId ? await getStoreLencoKey(storeId) : undefined;

        const country = req.query.country as string || 'zm';
        const banks = await LencoService.getBanks(country, lencoSecretKey);
        res.status(200).json(banks);
    } catch (error: any) {
        next(error);
    }
};

/**
 * Handle Lenco Webhook
 * POST /api/payments/lenco/webhook
 */
export const handleLencoWebhook = async (req: Request, res: Response, next: NextFunction) => {
    const client = await db._pool.connect();
    try {
        const payload = req.body;
        console.log('Received Lenco Webhook:', JSON.stringify(payload, null, 2));

        // Lenco recommends verifying the payload signature in production. 
        // For now, we'll process it and potentially verify with a status check if needed.

        if (payload.event === 'collection.successful') {
            const { reference, amount, currency } = payload.data;

            await client.query('BEGIN');

            // 1. Find the payment and sale associated with this reference
            const paymentResult = await client.query(
                'SELECT p.*, s.total, s.amount_paid, s.customer_id FROM payments p JOIN sales s ON p.sale_id = s.transaction_id WHERE p.reference = $1',
                [reference]
            );

            if (paymentResult.rowCount === 0) {
                console.warn(`Webhook: No payment found for reference ${reference}`);
                await client.query('ROLLBACK');
                res.status(200).json({ status: true, message: 'Processed (no matching sale)' });
                return;
            }

            const payment = toCamelCase(paymentResult.rows[0]);

            // 2. If already paid, skip
            if (payment.amount >= payment.total && payment.amountPaid >= payment.total) {
                await client.query('ROLLBACK');
                res.status(200).json({ status: true, message: 'Already processed' });
                return;
            }

            // 3. Update the sale status
            const newAmountPaid = Number(payment.amountPaid) + Number(amount);
            const newPaymentStatus = newAmountPaid >= Number(payment.total) ? 'paid' : 'partially_paid';

            await client.query(
                'UPDATE sales SET amount_paid = $1, payment_status = $2 WHERE transaction_id = $3',
                [newAmountPaid, newPaymentStatus, payment.saleId]
            );

            // 4. Log audit and accounting if needed 
            // (Note: This might be redundant if the user also clicks 'verify' on frontend, 
            // but webhook is the ultimate source of truth)

            await client.query('COMMIT');

            // --- Push Notification for Successful Payment ---
            try {
                const { pushService } = await import('../services/push.service');
                const storeId = (payment as any).store_id || (req as any).tenant?.storeId || (req as any).user?.currentStoreId;
                if (storeId) {
                    await pushService.sendToStore(storeId, {
                        title: 'Payment Received! 💰',
                        body: `Success! Received ${amount} ${currency || 'ZMW'} for Sale ID ${payment.saleId}.`,
                        url: `/sales/history`
                    });
                }
            } catch (pushErr) {
                console.error('Push failed for successful webhook payment:', pushErr);
            }

            console.log(`Webhook: Successfully updated sale ${payment.saleId} for reference ${reference}`);
        }

        res.status(200).json({ status: true });
    } catch (error: any) {
        if (client) await client.query('ROLLBACK');
        console.error('Webhook Error:', error.message);
        res.status(500).json({ status: false, message: 'Webhook processing failed' });
    } finally {
        if (client) client.release();
    }
};

/**
 * Initiate a Lenco payment (Generate reference)
 * POST /api/payments/lenco/initiate
 * Body: { prefix: string }
 */
export const initiatePayment = async (req: Request, res: Response) => {
    try {
        const { prefix } = req.body;
        const reference = LencoService.generateReference(prefix || 'SP');

        res.status(200).json({
            status: true,
            data: { reference }
        });
    } catch (error: any) {
        res.status(500).json({
            status: false,
            message: error.message || 'Failed to initiate payment reference'
        });
    }
};

/**
 * Charge Mobile Money directly
 * POST /api/payments/lenco/charge-mobile-money
 * Body: { amount: number, reference: string, phone: string, operator: string }
 */
export const chargeMobileMoney = async (req: Request, res: Response) => {
    try {
        const { amount, reference, phone, operator } = req.body;
        const storeId = (req as any).tenant?.storeId || (req as any).user?.currentStoreId;

        if (!storeId) {
            res.status(400).json({ status: false, message: 'Store context is required' });
            return;
        }

        if (!amount || !reference || !phone || !operator) {
            res.status(400).json({
                status: false,
                message: 'amount, reference, phone, and operator are required'
            });
            return;
        }

        const lencoSecretKey = await getStoreLencoKey(storeId);
        const result = await LencoService.chargeMobileMoney(amount, reference, phone, operator, 'zm', lencoSecretKey);

        res.status(200).json(result);
    } catch (error: any) {
        console.error('Charge Mobile Money Error:', error);
        res.status(200).json({
            status: false,
            message: error.message || 'Failed to initiate mobile money collection',
            data: error
        });
    }
};

/**
 * Cancel a Lenco payment
 * POST /api/payments/lenco/cancel
 * Body: { reference: string }
 */
export const cancelPayment = async (req: Request, res: Response) => {
    try {
        const { reference } = req.body;
        const storeId = (req as any).tenant?.storeId || (req as any).user?.currentStoreId;

        if (!storeId) {
            return res.status(400).json({ status: false, message: 'Store context is required' });
        }

        if (!reference) {
            return res.status(400).json({
                status: false,
                message: 'Reference is required'
            });
        }

        console.log(`Lenco payment reference cancelled by user: ${reference}`);

        // Note: For regular sales, we don't store pending references in the DB yet,
        // so we simply acknowledge the cancellation for the frontend to update its state.

        const lencoSecretKey = await getStoreLencoKey(storeId);

        // Best effort to notify Lenco
        await LencoService.cancelTransaction(reference, lencoSecretKey);

        res.status(200).json({
            status: true,
            message: 'Transaction cancelled successfully'
        });
    } catch (error: any) {
        res.status(500).json({
            status: false,
            message: error.message || 'Failed to cancel payment'
        });
    }
};
