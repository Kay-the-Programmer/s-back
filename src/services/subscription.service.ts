import db from '../db_client';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import dotenv from 'dotenv';
import { invalidateUserCache } from '../middleware/auth.middleware';
import LencoService from './lenco.service';
import { adminDb } from '../firebase';
import { setEnabledModules } from './entitlements.service';
import {
    getPlans as getCatalogPlans,
    getPlan as getCatalogPlan,
    modulesForPlan as catalogModulesForPlan,
    CatalogPlan,
} from './catalog.service';
import { processSuccessfulModulePayment } from './module-purchase.service';

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

const catalogToSubscriptionPlan = (p: CatalogPlan): SubscriptionPlan => ({
    id: p.id,
    name: p.name,
    price: p.price,
    currency: p.currency,
    interval: p.interval,
    description: p.description,
    features: p.features,
    aiRequestsLimit: p.aiRequestsLimit,
});

/** Live plans for the pricing UI — Super-Admin-edited catalog, falling back to constants. */
export const getPlans = async (): Promise<SubscriptionPlan[]> => {
    try {
        const plans = await getCatalogPlans(false);
        if (plans.length) return plans.map(catalogToSubscriptionPlan);
    } catch (e: any) {
        console.warn('[subscription] catalog plans unavailable, using constants:', e.message);
    }
    return SUBSCRIPTION_PLANS;
};

/** Static lookup (constants only) — kept for back-compat callers that need it sync. */
export const getPlanById = (planId: string) => {
    return SUBSCRIPTION_PLANS.find(p => p.id === planId);
};

/** Effective plan (price/features) from the catalog, falling back to constants. */
export const getEffectivePlan = async (planId: string): Promise<SubscriptionPlan | undefined> => {
    try {
        const p = await getCatalogPlan(planId);
        if (p) return catalogToSubscriptionPlan(p);
    } catch { /* fall through to constants */ }
    return SUBSCRIPTION_PLANS.find(p => p.id === planId);
};

export type BillingCycle = 'monthly' | 'annual';

/** Annual discount, e.g. 20 = pay 12 months at 20% off (≈ 9.6 months). */
export const ANNUAL_DISCOUNT_PERCENT = parseInt(process.env.ANNUAL_DISCOUNT_PERCENT || '20', 10);

const normalizeCycle = (c?: string): BillingCycle => (c === 'annual' || c === 'year' || c === 'yearly' ? 'annual' : 'monthly');

/** The amount to charge for a plan given the billing cycle (annual applies the discount). */
export const chargeForCycle = (monthlyPrice: number, cycle: BillingCycle): number =>
    cycle === 'annual' ? Math.round(monthlyPrice * 12 * (1 - ANNUAL_DISCOUNT_PERCENT / 100)) : monthlyPrice;

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

export const initiatePayment = async (storeId: string, planId: string, method: string, phoneNumber?: string, billingCycle?: string) => {
    // Charge the Super-Admin-configured price (catalog), not a hardcoded constant.
    const plan = await getEffectivePlan(planId);
    if (!plan) throw new Error('Invalid plan selected');

    const cycle = normalizeCycle(billingCycle);
    const baseCharge = chargeForCycle(plan.price, cycle); // annual applies the discount
    const paymentId = `pay_${uuidv4()}`;
    const currency = plan.currency;

    // Use a unique reference for Lenco
    const reference = `SP_SUB_${Date.now()}_${storeId.substring(0, 8).toUpperCase()}`;

    // Apply available discount balance against the (possibly annual) charge.
    const storeRes = await db.query('SELECT discount_balance FROM stores WHERE id = $1', [storeId]);
    const availableDiscount = parseFloat(storeRes.rows[0]?.discount_balance || '0');
    let finalAmount = baseCharge;
    let appliedDiscount = 0;

    if (availableDiscount > 0) {
        appliedDiscount = Math.min(availableDiscount, baseCharge);
        finalAmount = baseCharge - appliedDiscount;

        // Deduct from store's balance
        await db.query('UPDATE stores SET discount_balance = discount_balance - $1 WHERE id = $2', [appliedDiscount, storeId]);
    }

    // Insert pending payment record (billing_cycle drives the period extended on success)
    await db.query(
        `INSERT INTO subscription_payments
        (id, store_id, amount, currency, plan_id, method, reference, notes, billing_cycle, created_at, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), $10)`,
        [paymentId, storeId, finalAmount, currency, planId, method, reference, `Plan: ${plan.name} (${cycle}), Discount applied: ${appliedDiscount}, Phone: ${phoneNumber || 'N/A'}`, cycle, 'pending']
    );

    let lencoResult = null;
    if (method === 'mobile-money' && phoneNumber) {
        try {
            // Determine operator - simple logic or pass from frontend
            // For now, assume Airtel if it starts with 097/077 or MTN if 096/076
            lencoResult = await LencoService.chargeMobileMoney(finalAmount, reference, phoneNumber);
        } catch (error) {
            console.error('Failed to trigger direct mobile money charge:', error);
            // We don't throw here, as we still have the reference and can fallback to widget if needed
        }
    }

    return {
        paymentId,
        reference,
        amount: finalAmount,
        appliedDiscount,
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

    // Add-on purchases are tagged with module_ids — process them as à-la-carte
    // grants (their own billing periods) rather than a plan subscription.
    if (Array.isArray(payment.module_ids) && payment.module_ids.length > 0) {
        return processSuccessfulModulePayment(reference, lencoDetails);
    }

    if (payment.status === 'completed') {
        return payment.id; // Already processed
    }

    // 2. Mark payment as completed
    await db.query(
        'UPDATE subscription_payments SET paid_at = NOW(), status = $1, transaction_id = $2 WHERE id = $3',
        ['completed', lencoDetails.lencoReference, payment.id]
    );

    // 3. Extend the subscription from the LATER of now / current end (so a renewal
    //    stacks on top of remaining time instead of truncating it), and grant the
    //    plan's add-on modules so paying actually unlocks features.
    const planId = payment.plan_id || 'plan_pro';
    const curRes = await db.query('SELECT subscription_ends_at FROM stores WHERE id = $1', [storeId]);
    const curEnd = curRes.rows[0]?.subscription_ends_at ? new Date(curRes.rows[0].subscription_ends_at) : null;
    const base = curEnd && curEnd.getTime() > Date.now() ? curEnd : new Date();
    const endDate = new Date(base);
    // Annual payments extend a full year; monthly extend one month.
    endDate.setMonth(endDate.getMonth() + (payment.billing_cycle === 'annual' ? 12 : 1));

    await db.query(
        `UPDATE stores
         SET subscription_status = 'active',
             subscription_plan = $1,
             subscription_ends_at = $2,
             subscription_billing_cycle = $4,
             plan_renewal_attempts = 0,
             updated_at = NOW()
         WHERE id = $3`,
        [planId, endDate, storeId, payment.billing_cycle || 'monthly']
    );

    // Reconcile the tier checkout with the entitlement system: grant the modules
    // this plan includes (free-core + paid add-ons model). Without this, a paying
    // customer would still hit every premium paywall.
    try {
        await setEnabledModules(storeId, await catalogModulesForPlan(planId));
    } catch (modErr) {
        console.error('Failed to grant plan modules after payment:', modErr);
    }

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

    const planId = payment.plan_id || 'plan_pro';
    const endDate = new Date();
    endDate.setMonth(endDate.getMonth() + (payment.billing_cycle === 'annual' ? 12 : 1));

    await db.query(
        `UPDATE stores
         SET subscription_status = 'active',
             subscription_plan = $1,
             subscription_ends_at = $2,
             updated_at = NOW()
         WHERE id = $3`,
        [planId, endDate, storeId]
    );

    try {
        await setEnabledModules(storeId, await catalogModulesForPlan(planId));
    } catch (modErr) {
        console.error('Failed to grant plan modules after mock payment:', modErr);
    }

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
        const isAddon = Array.isArray(row.module_ids) && row.module_ids.length > 0;
        const plan = SUBSCRIPTION_PLANS.find(p => p.id === row.plan_id) || SUBSCRIPTION_PLANS[1];
        const planName = isAddon
            ? (row.module_ids.length > 1 ? `Add-ons (${row.module_ids.length})` : 'Add-on')
            : `${plan.name}${row.billing_cycle === 'annual' ? ' (yearly)' : ''}`;
        const startDate = new Date(row.created_at);
        const endDate = new Date(startDate);
        endDate.setMonth(endDate.getMonth() + 1); // Approximation

        return {
            id: row.id,
            planName,
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

// --- Plan auto-renew & dunning ----------------------------------------------

const PLAN_RENEW_LEAD_DAYS = parseInt(process.env.PLAN_RENEW_LEAD_DAYS || '3', 10);
const PLAN_RENEW_RETRY_HOURS = parseInt(process.env.PLAN_RENEW_RETRY_HOURS || '24', 10);
const PLAN_RENEW_MAX_ATTEMPTS = parseInt(process.env.PLAN_RENEW_MAX_ATTEMPTS || '3', 10);
// Global kill-switch: when false the job only reminds (no auto-initiated charge).
const PLAN_AUTO_CHARGE = (process.env.PLAN_AUTO_CHARGE ?? 'true') !== 'false';

/** Whether the store's plan currently auto-renews. */
export const getPlanAutoRenew = async (storeId: string): Promise<boolean> => {
    const r = await db.query('SELECT plan_auto_renew FROM stores WHERE id = $1', [storeId]);
    return r.rowCount ? r.rows[0].plan_auto_renew !== false : true;
};

/** Turn plan auto-renew on/off for a store. */
export const setPlanAutoRenew = async (storeId: string, autoRenew: boolean): Promise<void> => {
    await db.query('UPDATE stores SET plan_auto_renew = $1, updated_at = NOW() WHERE id = $2', [autoRenew, storeId]);
};

const planOwnerPhone = async (storeId: string): Promise<string | null> => {
    const r = await db.query('SELECT u.phone FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.id = $1', [storeId]);
    return r.rows[0]?.phone || null;
};

const pushToStore = async (storeId: string, title: string, body: string) => {
    try {
        const users = await db.query('SELECT id FROM users WHERE current_store_id = $1', [storeId]);
        const userIds = users.rows.map((u: any) => u.id as string);
        if (userIds.length === 0) return;
        const { pushService } = await import('./push.service');
        await pushService.sendToUsers(userIds, { title, body, url: '/settings/subscription' }).catch(() => {});
    } catch { /* best effort */ }
};

/**
 * Auto-renew & dunning for subscription PLANS (mirrors the add-on renewal job).
 * Mobile-money has no stored mandate, so renewals are *initiated* near expiry and
 * the merchant approves a USSD prompt — never a silent debit. Phases:
 *   1. Confirm pending plan-renewal charges (extend on success via the normal flow).
 *   2. Initiate renewals for auto-renew stores nearing expiry (capped + spaced).
 *   3. Remind stores whose plan will lapse but have auto-renew off.
 */
export const runPlanRenewals = async (): Promise<number> => {
    let actions = 0;

    // --- Phase 1: confirm pending plan renewals ------------------------------
    await db.query(
        `UPDATE subscription_payments SET status = 'failed'
          WHERE status = 'pending' AND reference LIKE 'SP_RENEW_PLAN_%'
            AND created_at < NOW() - INTERVAL '2 days'`
    );
    const pending = await db.query(
        `SELECT reference FROM subscription_payments
          WHERE status = 'pending' AND reference LIKE 'SP_RENEW_PLAN_%'
            AND created_at > NOW() - INTERVAL '2 days'`
    );
    for (const row of pending.rows) {
        try {
            const resp = await LencoService.verifyTransaction(row.reference);
            if (resp?.status && resp?.data?.status === 'successful') {
                await processSuccessfulPayment(row.reference, resp.data);
                actions++;
            } else if (resp?.data?.status === 'failed') {
                await db.query(`UPDATE subscription_payments SET status = 'failed' WHERE reference = $1`, [row.reference]);
            }
        } catch (e: any) {
            console.warn(`[plan-renewal] verify failed for ${row.reference}:`, e.message);
        }
    }

    // --- Phase 2: initiate renewals near expiry ------------------------------
    const due = await db.query(
        `SELECT s.id, s.subscription_plan, s.subscription_billing_cycle
           FROM stores s
          WHERE s.subscription_status = 'active' AND s.plan_auto_renew = TRUE
            AND s.subscription_plan IS NOT NULL
            AND s.subscription_ends_at > NOW()
            AND s.subscription_ends_at <= NOW() + make_interval(days => $1)
            AND s.plan_renewal_attempts < $2
            AND (s.plan_last_renewal_at IS NULL OR s.plan_last_renewal_at < NOW() - make_interval(hours => $3))
            AND NOT EXISTS (
                SELECT 1 FROM subscription_payments sp
                 WHERE sp.store_id = s.id AND sp.status = 'pending' AND sp.reference LIKE 'SP_RENEW_PLAN_%'
            )`,
        [PLAN_RENEW_LEAD_DAYS, PLAN_RENEW_MAX_ATTEMPTS, PLAN_RENEW_RETRY_HOURS]
    );

    for (const store of due.rows) {
        const storeId = store.id as string;
        try {
            const plan = await getEffectivePlan(store.subscription_plan);
            if (!plan) continue;
            const cycle = normalizeCycle(store.subscription_billing_cycle);
            const amount = chargeForCycle(plan.price, cycle);
            if (amount <= 0) continue; // free plan — nothing to charge

            const phone = await planOwnerPhone(storeId);
            const reference = `SP_RENEW_PLAN_${Date.now()}_${storeId.substring(0, 8).toUpperCase()}`;
            const paymentId = `pay_${uuidv4()}`;

            await db.query(
                `INSERT INTO subscription_payments
                    (id, store_id, amount, currency, plan_id, method, reference, notes, billing_cycle, created_at, status)
                 VALUES ($1, $2, $3, $4, $5, 'mobile-money', $6, $7, $8, NOW(), 'pending')`,
                [paymentId, storeId, amount, plan.currency, store.subscription_plan, reference, `Auto-renew: ${plan.name} (${cycle})`, cycle]
            );

            let charged = false;
            if (PLAN_AUTO_CHARGE && phone) {
                try { await LencoService.chargeMobileMoney(amount, reference, phone); charged = true; }
                catch (e: any) { console.warn(`[plan-renewal] charge init failed for ${storeId}:`, e.message); }
            }

            await db.query(
                `UPDATE stores SET plan_renewal_attempts = plan_renewal_attempts + 1,
                        plan_last_renewal_at = NOW(), plan_last_renewal_reference = $2 WHERE id = $1`,
                [storeId, reference]
            );

            await pushToStore(
                storeId,
                charged ? `Renewing your ${plan.name} plan` : `Your ${plan.name} plan renews soon`,
                charged
                    ? `Approve the prompt on your phone to keep your ${plan.name} plan active (${plan.currency} ${amount}).`
                    : `Your ${plan.name} plan is about to expire. Open SalePilot to renew it.`,
            );
            actions++;
        } catch (e: any) {
            console.error(`[plan-renewal] initiate failed for ${storeId}:`, e.message);
        }
    }

    // --- Phase 3: remind stores with auto-renew OFF --------------------------
    const manual = await db.query(
        `SELECT id, subscription_plan FROM stores
          WHERE subscription_status = 'active' AND plan_auto_renew = FALSE
            AND subscription_plan IS NOT NULL
            AND subscription_ends_at > NOW()
            AND subscription_ends_at <= NOW() + make_interval(days => $1)
            AND (plan_last_renewal_at IS NULL OR plan_last_renewal_at < NOW() - make_interval(hours => $2))`,
        [PLAN_RENEW_LEAD_DAYS, PLAN_RENEW_RETRY_HOURS]
    );
    for (const store of manual.rows) {
        try {
            await db.query('UPDATE stores SET plan_last_renewal_at = NOW() WHERE id = $1', [store.id]);
            const plan = await getEffectivePlan(store.subscription_plan);
            await pushToStore(store.id, `${plan?.name || 'Your plan'} expires soon`, 'Auto-renew is off. Renew in SalePilot to keep your plan.');
            actions++;
        } catch (e: any) {
            console.warn(`[plan-renewal] manual reminder failed for ${store.id}:`, e.message);
        }
    }

    if (actions) console.log(`[plan-renewal] processed ${actions} action(s).`);
    return actions;
};

