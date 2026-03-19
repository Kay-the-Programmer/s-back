import db from '../db_client';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import dotenv from 'dotenv';
import { invalidateUserCache } from '../middleware/auth.middleware';
import LencoService from './lenco.service';
import { adminDb } from '../firebase';

dotenv.config();

const getLencoConfig = () => ({
    secretKey: process.env.LENCO_SECRET_KEY,
    baseUrl: (process.env.LENCO_API_BASE_URL || 'https://api.lenco.co/access/v2').replace(/\/+$/, '')
});

export interface SubscriptionPlan {
    id: string;
    name: string;
    price: number;
    currency: string;
    interval: 'month' | 'year';
    description: string;
    features: string[];
    aiRequestsLimit: number; // Monthly limit, -1 for unlimited
}

export const SUBSCRIPTION_PLANS: SubscriptionPlan[] = [
    {
        id: 'plan_basic',
        name: 'Basic',
        price: 99,
        currency: 'ZMW',
        interval: 'month',
        description: 'Essential features for small businesses',
        features: [
            'Up to 100 Products',
            'Basic Sales Reports',
            '1 User Account',
            '50 AI Requests/month',
            'Email Support'
        ],
        aiRequestsLimit: 50
    },
    {
        id: 'plan_pro',
        name: 'Pro',
        price: 249,
        currency: 'ZMW',
        interval: 'month',
        description: 'Advanced tools for growing stores',
        features: [
            'Unlimited Products',
            'Advanced Analytics',
            'Up to 5 User Accounts',
            '500 AI Requests/month',
            'Inventory Alerts',
            'Priority Support'
        ],
        aiRequestsLimit: 500
    },
    {
        id: 'plan_enterprise',
        name: 'Enterprise',
        price: 599,
        currency: 'ZMW',
        interval: 'month',
        description: 'Complete solution for large operations',
        features: [
            'Unlimited Everything',
            'Custom Reports',
            'Unlimited AI Requests',
            'Dedicated Account Manager',
            'API Access',
            'Multi-store Management'
        ],
        aiRequestsLimit: -1
    }
];

export const getPlans = async () => {
    return SUBSCRIPTION_PLANS;
};

export const getPlanById = (planId: string) => {
    return SUBSCRIPTION_PLANS.find(p => p.id === planId);
};

export const subscriptionService = {
    getPlans,
    getPlanById,
    initiatePayment: (async (...args: any[]) => {
        // @ts-ignore
        return initiatePayment(...args);
    }) as any, // Placeholder for type safety if needed, or just export the functions
    verifyPayment: (async (...args: any[]) => {
        // @ts-ignore
        return verifyPayment(...args);
    }) as any
};

export const initiatePayment = async (storeId: string, planId: string, method: string, phoneNumber?: string) => {
    const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
    if (!plan) throw new Error('Invalid plan selected');

    const paymentId = `pay_${uuidv4()}`;
    const amount = plan.price;
    const currency = plan.currency;

    // Use a unique reference for Lenco
    const reference = `SP_SUB_${Date.now()}_${storeId.substring(0, 8).toUpperCase()}`;

    // Insert pending payment record
    await db.query(
        `INSERT INTO subscription_payments 
        (id, store_id, amount, currency, plan_id, method, reference, notes, created_at, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9)`,
        [paymentId, storeId, amount, currency, planId, method, reference, `Plan: ${plan.name}, Phone: ${phoneNumber || 'N/A'}`, 'pending']
    );

    let lencoResult = null;
    if (method === 'mobile-money' && phoneNumber) {
        try {
            // Determine operator - simple logic or pass from frontend
            // For now, assume Airtel if it starts with 097/077 or MTN if 096/076
            lencoResult = await LencoService.chargeMobileMoney(amount, reference, phoneNumber);
        } catch (error) {
            console.error('Failed to trigger direct mobile money charge:', error);
            // We don't throw here, as we still have the reference and can fallback to widget if needed
        }
    }

    return {
        paymentId,
        reference,
        amount,
        currency,
        status: 'pending',
        lencoResult,
        message: method === 'mobile-money' ? 'Payment initiated. Please check your phone for a prompt.' : 'Payment initiated. Proceed with Lenco popup.'
    };
};

export const verifyPayment = async (reference: string) => {
    try {
        const { secretKey, baseUrl } = getLencoConfig();
        const response = await axios.get(`${baseUrl}/collections/status/${reference}`, {
            headers: {
                'Authorization': `Bearer ${secretKey}`
            }
        });

        const lencoData = response.data;

        const lencoStatus = lencoData.data?.status;

        if (lencoData.status && lencoStatus === 'successful') {
            const paymentId = await processSuccessfulPayment(reference, lencoData.data);
            return { success: true, paymentId };
        } else if (lencoData.status && lencoStatus !== 'failed') {
            return { success: false, pending: true, message: `Payment status: ${lencoStatus || 'processing'}` };
        }

        return { success: false, message: lencoData.data?.reasonForFailure || `Payment ${lencoStatus || 'failed'}` };
    } catch (error: any) {
        console.error('Lenco Verification Error:', error.response?.data || error.message);
        throw new Error('Failed to verify payment with Lenco');
    }
};

const processSuccessfulPayment = async (reference: string, lencoDetails: any) => {
    // 1. Get payment details from our DB
    const paymentRes = await db.query('SELECT * FROM subscription_payments WHERE reference = $1', [reference]);
    if (paymentRes.rowCount === 0) throw new Error('Payment record not found');

    const payment = paymentRes.rows[0];
    const storeId = payment.store_id;

    if (payment.status === 'completed') {
        return payment.id; // Already processed
    }

    // 2. Mark payment as completed
    await db.query(
        'UPDATE subscription_payments SET paid_at = NOW(), status = $1, transaction_id = $2 WHERE id = $3',
        ['completed', lencoDetails.lencoReference, payment.id]
    );

    // 3. Update store subscription status
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    await db.query(
        `UPDATE stores 
         SET subscription_status = 'active', 
             subscription_plan = $1,
             subscription_ends_at = $2, 
             updated_at = NOW() 
         WHERE id = $3`,
        [payment.plan_id || 'plan_pro', endDate, storeId]
    );

    // 4. Invalidate cache for users of this store (or just the processing user)
    // For simplicity, we invalidate the cache if we had a userId, but we don't have it here easily.
    // However, the middleware will fetch fresh data if /api/auth/me is called.
    // To be safe, we can't easily find all userIds for this store without another query.
    // We'll skip explicit invalidation for now as the 60s TTL is short enough, 
    // or we can just hope the frontend refetches user info.

    // --- Trigger Cloud Function for Subscription Extension ---
    if (adminDb) {
        try {
            const storeResult = await db.query('SELECT owner_id FROM stores WHERE id = $1', [storeId]);
            if (storeResult.rowCount && storeResult.rowCount > 0) {
                const ownerId = storeResult.rows[0].owner_id;
                const userResult = await db.query('SELECT email, name FROM users WHERE id = $1', [ownerId]);
                if (userResult.rowCount && userResult.rowCount > 0 && userResult.rows[0].email) {
                    await adminDb.collection('mail_events').add({
                        type: 'SUBSCRIPTION_ACTIVE',
                        storeId,
                        planId: payment.plan_id || 'plan_pro',
                        userEmail: userResult.rows[0].email,
                        userName: userResult.rows[0].name,
                        paymentId: payment.id,
                        timestamp: new Date().toISOString()
                    });
                    console.log(`Added SUBSCRIPTION_ACTIVE event for store ${storeId} to Firestore mail_events.`);
                }
            }
        } catch (eventError) {
            console.error('Failed to trigger subscription event:', eventError);
        }
    }
    // ----------------------------------------------------

    // --- Push Notification for Subscription ---
    try {
        const { pushService } = await import('./push.service');
        const userRes = await db.query('SELECT id FROM users WHERE current_store_id = $1', [storeId]);
        const userIds = userRes.rows.map(u => u.id);
        if (userIds.length > 0) {
            await pushService.sendToUsers(userIds, {
                title: 'Subscription Active! ✨',
                body: `Your store is now on the ${payment.plan_id || 'Pro'} plan. Thank you for your support!`,
                url: '/settings/subscription'
            });
        }
    } catch (pushErr) {
        console.error('Push failed for subscription active:', pushErr);
    }
    // ----------------------------------------------------

    return payment.id;
}

export const cancelPayment = async (reference: string) => {
    const result = await db.query(
        'UPDATE subscription_payments SET status = $1 WHERE reference = $2 AND status = $3 RETURNING *',
        ['cancelled', reference, 'pending']
    );
    if (result.rowCount === 0) {
        throw new Error('Payment not found or already processed');
    }

    // Best effort to notify Lenco
    await LencoService.cancelTransaction(reference);

    // --- Trigger Cloud Function for Subscription Extension ---
    if (adminDb && result.rowCount && result.rowCount > 0) {
        try {
            const payment = result.rows[0];
            const storeResult = await db.query('SELECT owner_id FROM stores WHERE id = $1', [payment.store_id]);
            if (storeResult.rowCount && storeResult.rowCount > 0) {
                const ownerId = storeResult.rows[0].owner_id;
                const userResult = await db.query('SELECT email, name FROM users WHERE id = $1', [ownerId]);
                if (userResult.rowCount && userResult.rowCount > 0 && userResult.rows[0].email) {
                    await adminDb.collection('mail_events').add({
                        type: 'SUBSCRIPTION_CANCELLED',
                        storeId: payment.store_id,
                        planId: payment.plan_id || 'unknown',
                        userEmail: userResult.rows[0].email,
                        userName: userResult.rows[0].name,
                        paymentId: payment.id,
                        timestamp: new Date().toISOString()
                    });
                    console.log(`Added SUBSCRIPTION_CANCELLED event for store ${payment.store_id} to Firestore mail_events.`);
                }
            }
        } catch (eventError) {
            console.error('Failed to trigger subscription cancel event:', eventError);
        }
    }
    // ----------------------------------------------------

    return result.rows[0];
};

export const processMockPayment = async (paymentId: string) => {
    // This remains for backward compatibility or direct mock testing
    const paymentRes = await db.query('SELECT * FROM subscription_payments WHERE id = $1', [paymentId]);
    if (paymentRes.rowCount === 0) throw new Error('Payment not found');

    const payment = paymentRes.rows[0];
    const storeId = payment.store_id;

    await db.query(
        'UPDATE subscription_payments SET paid_at = NOW(), status = $1 WHERE id = $2',
        ['completed', paymentId]
    );

    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + 1);

    await db.query(
        `UPDATE stores 
         SET subscription_status = 'active', 
             subscription_plan = $1,
             subscription_ends_at = $2, 
             updated_at = NOW() 
         WHERE id = $3`,
        [payment.plan_id || 'plan_pro', endDate, storeId]
    );

    return { success: true, newStatus: 'active', expiresAt: endDate };
};

export const getSubscriptionHistory = async (storeId: string) => {
    const result = await db.query(
        `SELECT * FROM subscription_payments 
         WHERE store_id = $1 
         ORDER BY created_at DESC`,
        [storeId]
    );

    return result.rows.map(row => {
        const plan = SUBSCRIPTION_PLANS.find(p => p.id === row.plan_id) || SUBSCRIPTION_PLANS[1];
        const startDate = new Date(row.created_at);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1); // Approximation

        return {
            id: row.id,
            planName: plan.name,
            amount: parseFloat(row.amount),
            currency: row.currency,
            status: row.status === 'completed' ? 'succeeded' : row.status,
            startDate: startDate.toISOString(),
            endDate: endDate.toISOString(),
            paymentMethod: row.method,
            reference: row.reference,
            createdAt: row.created_at,
            invoiceId: `INV-${row.reference.substring(7, 15)}`, // Generate a pseudo invoice ID
            invoiceUrl: '#' // We handle generation on frontend
        };
    });
};

