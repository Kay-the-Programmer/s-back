import db from '../db_client';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import LencoService from './lenco.service';
import { getModules } from './catalog.service';
import { addEnabledModules, getEnabledModules } from './entitlements.service';
import { invalidateUserCache } from '../middleware/auth.middleware';

/**
 * What is left of à-la-carte add-on purchases.
 *
 * SalePilot used to sell individual modules alongside the plan. It does not:
 * the three tiers include every feature and differ on capacity, so there is
 * nothing to buy per feature and the catalogue of purchasable add-ons is
 * empty. Everything that could start, price or renew such a purchase has been
 * removed along with its routes.
 *
 * These two remain on purpose. `module_purchases` rows may still exist from
 * before the pivot, so the lifecycle job must keep honouring them rather than
 * revoking a module someone paid for; and a Lenco webhook for a charge
 * started back then still has to land somewhere sane rather than 500.
 */

const ADDON_PERIOD_DAYS = parseInt(process.env.ADDON_PERIOD_DAYS || '30', 10);

/** Add-ons a store can buy à la carte, with ownership + current period info. */
/** Turn auto-renew on/off for a store's à-la-carte add-on. */
/** Begin an add-on purchase: validate, price from the catalog, charge via Lenco. */
/**
 * Finalize a verified add-on payment: grant the modules and (re)start their
 * billing periods. Called from `verifyPayment` when the payment row is an add-on
 * purchase (has `module_ids`). Idempotent on already-completed payments.
 */
export const processSuccessfulModulePayment = async (reference: string, lencoDetails: any): Promise<string> => {
    const paymentRes = await db.query('SELECT * FROM subscription_payments WHERE reference = $1', [reference]);
    if (paymentRes.rowCount === 0) throw new Error('Payment record not found');
    const payment = paymentRes.rows[0];
    const storeId = payment.store_id as string;
    const moduleIds: string[] = Array.isArray(payment.module_ids) ? payment.module_ids : [];

    if (payment.status === 'completed') return payment.id;
    if (moduleIds.length === 0) throw new Error('Payment has no add-on modules');

    await db.query(
        'UPDATE subscription_payments SET paid_at = NOW(), status = $1, transaction_id = $2 WHERE id = $3',
        ['completed', lencoDetails?.lencoReference || null, payment.id]
    );

    // Price each module for its own record, then (re)start a billing period.
    const catalog = await getModules(true);
    const priceById = new Map(catalog.map(m => [m.id, { price: m.price, currency: m.currency }]));
    for (const moduleId of moduleIds) {
        const info = priceById.get(moduleId) || { price: 0, currency: payment.currency || 'ZMW' };
        await db.query(
            `INSERT INTO module_purchases (store_id, module_id, status, current_period_end, price, currency, reference, updated_at)
             VALUES ($1, $2, 'active', NOW() + ($3 || ' days')::interval, $4, $5, $6, NOW())
             ON CONFLICT (store_id, module_id) DO UPDATE SET
                status = 'active',
                current_period_end = GREATEST(module_purchases.current_period_end, NOW()) + ($3 || ' days')::interval,
                price = EXCLUDED.price, currency = EXCLUDED.currency,
                reference = EXCLUDED.reference, renewal_attempts = 0, updated_at = NOW()`,
            [storeId, moduleId, String(ADDON_PERIOD_DAYS), info.price, info.currency, reference]
        );
    }

    await addEnabledModules(storeId, moduleIds);

    // Attribute the conversion to the campaign that drove it (server-authored, so
    // revenue is the real charged amount and can't be spoofed). The payment total
    // is split across modules by catalogue price.
    // Conversion attribution to the upsell campaign engine used to happen
    // here. Nothing is sold per feature any more, so there is no campaign to
    // attribute a purchase to.

    // Refresh auth cache + nudge the user.
    try {
        const users = await db.query('SELECT id FROM users WHERE current_store_id = $1', [storeId]);
        const userIds = users.rows.map((u: any) => u.id as string);
        userIds.forEach(invalidateUserCache);
        if (userIds.length > 0) {
            const { pushService } = await import('./push.service');
            await pushService.sendToUsers(userIds, {
                title: 'Add-on unlocked! 🎉',
                body: `Your new add-on${moduleIds.length > 1 ? 's are' : ' is'} now active. Enjoy!`,
                url: '/settings/subscription',
            }).catch(() => {});
        }
    } catch (e: any) {
        console.warn('[addon] post-purchase notify failed:', e.message);
    }

    return payment.id;
};

/** Module ids a store currently has via an unexpired à-la-carte purchase. */
export const getActivePurchasedModuleIds = async (storeId: string): Promise<string[]> => {
    const res = await db.query(
        `SELECT module_id FROM module_purchases WHERE store_id = $1 AND status = 'active' AND current_period_end > NOW()`,
        [storeId]
    );
    return res.rows.map((r: any) => r.module_id as string);
};

// --- Auto-renew --------------------------------------------------------------

const pushToStore = async (storeId: string, title: string, body: string) => {
    try {
        const users = await db.query('SELECT id FROM users WHERE current_store_id = $1', [storeId]);
        const userIds = users.rows.map((u: any) => u.id as string);
        if (userIds.length === 0) return;
        const { pushService } = await import('./push.service');
        await pushService.sendToUsers(userIds, { title, body, url: '/settings/subscription' }).catch(() => {});
    } catch { /* best effort */ }
};

const ownerPhone = async (storeId: string): Promise<string | null> => {
    const r = await db.query(
        `SELECT u.phone FROM stores s JOIN users u ON u.id = s.owner_id WHERE s.id = $1`,
        [storeId]
    );
    return r.rows[0]?.phone || null;
};

/**
 * Auto-renew & dunning for à-la-carte add-ons. Mobile-money charges always
 * require the merchant to approve a USSD prompt (no stored mandate), so this
 * *initiates* the renewal automatically near expiry and asks them to approve —
 * it never debits silently. Three phases per run:
 *   1. Confirm in-flight renewal charges (verify with Lenco, extend on success).
 *   2. Initiate renewals for auto-renew add-ons nearing expiry (capped + spaced).
 *   3. Remind merchants whose add-ons will lapse but have auto-renew off.
 */
