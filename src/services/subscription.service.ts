import db from '../db_client';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';

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
    // This is a draft implementation. In a real scenario, this would integrate with Airtel Money API.
    // For now, we will create a pending payment record.

    const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId);
    if (!plan) throw new Error('Invalid plan selected');

    const paymentId = `pay_${uuidv4()}`;
    const amount = plan.price;
    const currency = plan.currency;

    // Insert pending payment record
    await db.query(
        `INSERT INTO subscription_payments 
        (id, store_id, amount, currency, method, notes, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [paymentId, storeId, amount, currency, method, `Plan: ${plan.name}, Phone: ${phoneNumber || 'N/A'}`]
    );

    return {
        paymentId,
        amount,
        currency,
        status: 'pending',
        message: 'Payment initiated. Please complete the transaction on your phone.'
    };
};

export const processMockPayment = async (paymentId: string) => {
    // Simulate a successful payment webhook/callback

    // 1. Get payment details
    const paymentRes = await db.query('SELECT * FROM subscription_payments WHERE id = $1', [paymentId]);
    if (paymentRes.rowCount === 0) throw new Error('Payment not found');

    const payment = paymentRes.rows[0];
    const storeId = payment.store_id;

    // 2. Mark payment as paid
    await db.query(
        'UPDATE subscription_payments SET paid_at = NOW(), reference = $1 WHERE id = $2',
        [`ref_${Date.now()}`, paymentId]
    );

    // 3. Update store subscription status
    // Calculate new end date (assuming 1 month for now)
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
