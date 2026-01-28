import { Request, Response, NextFunction } from 'express';
import LencoService from '../services/lenco.service';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';

/**
 * Verify a Lenco payment transaction
 * POST /api/payments/lenco/verify
 * Body: { reference: string }
 */
export const verifyPayment = async (req: Request, res: Response, next: NextFunction) => {
    const { reference } = req.body;
    try {

        if (!reference) {
            res.status(400).json({ status: false, message: 'Reference is required' });
            return;
        }

        console.log(`Verifying Lenco payment: ${reference}`);
        const transaction = await LencoService.verifyTransaction(reference);

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
        const country = req.query.country as string || 'zm';
        const banks = await LencoService.getBanks(country);
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

        if (!amount || !reference || !phone || !operator) {
            res.status(400).json({
                status: false,
                message: 'amount, reference, phone, and operator are required'
            });
            return;
        }

        const result = await LencoService.chargeMobileMoney(amount, reference, phone, operator);

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
