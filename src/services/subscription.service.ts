import db from '../db_client';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import dotenv from 'dotenv';
import { invalidateUserCache } from '../middleware/auth.middleware';
import LencoService from './lenco.service';

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
            'Email Support'
        ]
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
            'Inventory Alerts',
            'Priority Support'
        ]
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
            'Dedicated Account Manager',
            'API Access',
            'Multi-store Management'
        ]
    }
];

export const getPlans = async () => {
    return SUBSCRIPTION_PLANS;
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

    return payment.id;
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

