import db from '../db_client';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

const LENCO_SECRET_KEY = process.env.LENCO_SECRET_KEY;
const LENCO_API_BASE_URL = process.env.LENCO_API_BASE_URL || 'https://api.lenco.co/access/v2';

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
    const reference = `SP_SUB_${Date.now()}_${storeId.substring(0, 8)}`;

    // Insert pending payment record
    await db.query(
        `INSERT INTO subscription_payments 
        (id, store_id, amount, currency, method, reference, notes, created_at, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8)`,
        [paymentId, storeId, amount, currency, method, reference, `Plan: ${plan.name}, Phone: ${phoneNumber || 'N/A'}`, 'pending']
    );

    return {
        paymentId,
        reference,
        amount,
        currency,
        status: 'pending',
        message: 'Payment initiated. Proceed with Lenco popup.'
    };
};

export const verifyPayment = async (reference: string) => {
    try {
        const response = await axios.get(`${LENCO_API_BASE_URL}/collections/status/${reference}`, {
            headers: {
                'Authorization': `Bearer ${LENCO_SECRET_KEY}`
            }
        });

        const lencoData = response.data;

        if (lencoData.status && lencoData.data.status === 'successful') {
            const paymentId = await processSuccessfulPayment(reference, lencoData.data);
            return { success: true, paymentId };
        }

        return { success: false, message: lencoData.data?.reasonForFailure || 'Payment not successful yet' };
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
             subscription_ends_at = $1, 
             updated_at = NOW() 
         WHERE id = $2`,
        [endDate, storeId]
    );

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
             subscription_ends_at = $1, 
             updated_at = NOW() 
         WHERE id = $2`,
        [endDate, storeId]
    );

    return { success: true, newStatus: 'active', expiresAt: endDate };
};

