import db from '../db_client';
// @ts-ignore
import { v4 as uuidv4 } from 'uuid';
import LencoService from './lenco.service';
import { getModules } from './catalog.service';
import { getModuleDiscounts } from './upsell-campaign.service';
import { addEnabledModules, getEnabledModules } from './entitlements.service';
import { invalidateUserCache } from '../middleware/auth.middleware';

/**
 * Self-serve à-la-carte add-on purchases. Mirrors the subscription payment flow
 * (same Lenco plumbing + `subscription_payments` table, tagged with `module_ids`)
 * but grants individual modules instead of a plan. Each purchase records a
 * `module_purchases` billing period so an independently-bought add-on expires on
 * its own schedule — no lifetime-access leak.
 */

const ADDON_PERIOD_DAYS = parseInt(process.env.ADDON_PERIOD_DAYS || '30', 10);
// Auto-renew tuning.
const RENEW_LEAD_DAYS = parseInt(process.env.ADDON_RENEW_LEAD_DAYS || '3', 10);     // start renewing this long before expiry
const RENEW_RETRY_HOURS = parseInt(process.env.ADDON_RENEW_RETRY_HOURS || '24', 10); // gap between attempts/reminders
const MAX_RENEW_ATTEMPTS = parseInt(process.env.ADDON_RENEW_MAX_ATTEMPTS || '3', 10);
// When false, the job only reminds (no auto-initiated charge) — a safe global kill-switch.
const ADDON_AUTO_CHARGE = (process.env.ADDON_AUTO_CHARGE ?? 'true') !== 'false';

export interface PurchasableAddon {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    owned: boolean;
    activeUntil: string | null;
    autoRenew: boolean;
}

/** Add-ons a store can buy à la carte, with ownership + current period info. */
export const getPurchasableAddons = async (storeId: string): Promise<PurchasableAddon[]> => {
    const modules = (await getModules(false)).filter(m => m.independentlyPurchasable && !m.isCore);
    const enabled = new Set(await getEnabledModules(storeId));
    const periods = await db.query(
        `SELECT module_id, current_period_end, auto_renew FROM module_purchases WHERE store_id = $1 AND status = 'active'`,
        [storeId]
    );
    const rowById = new Map<string, any>(periods.rows.map((r: any) => [r.module_id, r]));
    return modules.map(m => {
        const row = rowById.get(m.id);
        return {
            id: m.id,
            name: m.name,
            description: m.description,
            price: m.price,
            currency: m.currency,
            owned: enabled.has(m.id),
            activeUntil: row?.current_period_end ? new Date(row.current_period_end).toISOString() : null,
            autoRenew: row ? !!row.auto_renew : true,
        };
    });
};

/** Turn auto-renew on/off for a store's à-la-carte add-on. */
export const setAddonAutoRenew = async (storeId: string, moduleId: string, autoRenew: boolean): Promise<void> => {
    await db.query(
        `UPDATE module_purchases SET auto_renew = $1, updated_at = NOW() WHERE store_id = $2 AND module_id = $3`,
        [autoRenew, storeId, moduleId]
    );
};

/** Begin an add-on purchase: validate, price from the catalog, charge via Lenco. */
export const initiateModulePayment = async (
    storeId: string,
    moduleIds: string[],
    method: string,
    phoneNumber?: string,
) => {
    const catalog = (await getModules(false)).filter(m => m.independentlyPurchasable && !m.isCore);
    const byId = new Map(catalog.map(m => [m.id, m]));
    const chosen = Array.from(new Set((moduleIds || []).filter(id => byId.has(id)))).map(id => byId.get(id)!);
    if (chosen.length === 0) {
        throw new Error('No valid add-ons selected.');
    }

    const currency = chosen[0].currency || 'ZMW';
    // Apply any live campaign offer as an intro discount on the first charge
    // (server-validated; renewals stay at the catalogue price).
    const discounts = await getModuleDiscounts();
    const amount = chosen.reduce((sum, m) => {
        const pct = discounts[m.id] || 0;
        return sum + Math.round((m.price || 0) * (100 - pct)) / 100;
    }, 0);
    const discountApplied = chosen.some(m => (discounts[m.id] || 0) > 0);
    const paymentId = `pay_${uuidv4()}`;
    const reference = `SP_ADDON_${Date.now()}_${storeId.substring(0, 8).toUpperCase()}`;
    const names = chosen.map(m => m.name).join(', ');

    await db.query(
        `INSERT INTO subscription_payments
            (id, store_id, amount, currency, plan_id, method, reference, notes, module_ids, created_at, status)
         VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8, NOW(), 'pending')`,
        [paymentId, storeId, amount, currency, method, reference, `Add-ons: ${names}${discountApplied ? ' (offer applied)' : ''}`, chosen.map(m => m.id)]
    );

    let lencoResult = null;
    if (method === 'mobile-money' && phoneNumber) {
        try {
            lencoResult = await LencoService.chargeMobileMoney(amount, reference, phoneNumber);
        } catch (error) {
            console.error('Failed to trigger add-on mobile money charge:', error);
        }
    }

    return {
        paymentId,
        reference,
        amount,
        currency,
        moduleIds: chosen.map(m => m.id),
        status: 'pending',
        lencoResult,
        message: method === 'mobile-money'
            ? 'Payment initiated. Please check your phone for a prompt.'
            : 'Payment initiated. Proceed with the Lenco popup.',
    };
};

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
export const runAddonRenewals = async (): Promise<number> => {
    let actions = 0;

    // --- Phase 1: confirm pending renewal charges ----------------------------
    // Abandon prompts the merchant never approved (so a fresh attempt can fire).
    await db.query(
        `UPDATE subscription_payments SET status = 'failed'
          WHERE status = 'pending' AND reference LIKE 'SP_RENEW_%'
            AND created_at < NOW() - INTERVAL '2 days'`
    );
    const pending = await db.query(
        `SELECT reference FROM subscription_payments
          WHERE status = 'pending' AND reference LIKE 'SP_RENEW_%'
            AND created_at > NOW() - INTERVAL '2 days'`
    );
    for (const row of pending.rows) {
        try {
            const resp = await LencoService.verifyTransaction(row.reference);
            if (resp?.status && resp?.data?.status === 'successful') {
                await processSuccessfulModulePayment(row.reference, resp.data);
                actions++;
            } else if (resp?.data?.status === 'failed') {
                await db.query(`UPDATE subscription_payments SET status = 'failed' WHERE reference = $1`, [row.reference]);
            }
        } catch (e: any) {
            console.warn(`[renewal] verify failed for ${row.reference}:`, e.message);
        }
    }

    // --- Phase 2: initiate renewals for auto-renew add-ons near expiry --------
    const due = await db.query(
        `SELECT mp.store_id, mp.module_id, mp.renewal_attempts
           FROM module_purchases mp
          WHERE mp.status = 'active' AND mp.auto_renew = TRUE
            AND mp.current_period_end > NOW()
            AND mp.current_period_end <= NOW() + make_interval(days => $1)
            AND mp.renewal_attempts < $2
            AND (mp.last_renewal_at IS NULL OR mp.last_renewal_at < NOW() - make_interval(hours => $3))
            AND NOT EXISTS (
                SELECT 1 FROM subscription_payments sp
                 WHERE sp.store_id = mp.store_id AND sp.status = 'pending'
                   AND sp.reference LIKE 'SP_RENEW_%' AND sp.module_ids @> ARRAY[mp.module_id]
            )`,
        [RENEW_LEAD_DAYS, MAX_RENEW_ATTEMPTS, RENEW_RETRY_HOURS]
    );

    const catalog = await getModules(true);
    const moduleById = new Map(catalog.map(m => [m.id, m]));

    for (const row of due.rows) {
        const storeId = row.store_id as string;
        const moduleId = row.module_id as string;
        const mod = moduleById.get(moduleId);
        if (!mod) continue;
        try {
            const phone = await ownerPhone(storeId);
            const reference = `SP_RENEW_${Date.now()}_${storeId.substring(0, 8).toUpperCase()}`;
            const paymentId = `pay_${uuidv4()}`;

            await db.query(
                `INSERT INTO subscription_payments
                    (id, store_id, amount, currency, plan_id, method, reference, notes, module_ids, created_at, status)
                 VALUES ($1, $2, $3, $4, NULL, 'mobile-money', $5, $6, $7, NOW(), 'pending')`,
                [paymentId, storeId, mod.price, mod.currency, reference, `Auto-renew: ${mod.name}`, [moduleId]]
            );

            let charged = false;
            if (ADDON_AUTO_CHARGE && phone) {
                try { await LencoService.chargeMobileMoney(mod.price, reference, phone); charged = true; }
                catch (e: any) { console.warn(`[renewal] charge init failed for ${storeId}/${moduleId}:`, e.message); }
            }

            await db.query(
                `UPDATE module_purchases
                    SET renewal_attempts = renewal_attempts + 1, last_renewal_at = NOW(), last_renewal_reference = $3
                  WHERE store_id = $1 AND module_id = $2`,
                [storeId, moduleId, reference]
            );

            await pushToStore(
                storeId,
                charged ? `Renewing ${mod.name}` : `${mod.name} renews soon`,
                charged
                    ? `Approve the prompt on your phone to keep ${mod.name} active (${mod.currency} ${mod.price}).`
                    : `Your ${mod.name} add-on is about to expire. Open SalePilot to renew it.`,
            );
            actions++;
        } catch (e: any) {
            console.error(`[renewal] initiate failed for ${storeId}/${moduleId}:`, e.message);
        }
    }

    // --- Phase 3: remind merchants with auto-renew OFF ------------------------
    const manual = await db.query(
        `SELECT store_id, module_id FROM module_purchases
          WHERE status = 'active' AND auto_renew = FALSE
            AND current_period_end > NOW()
            AND current_period_end <= NOW() + make_interval(days => $1)
            AND (last_renewal_at IS NULL OR last_renewal_at < NOW() - make_interval(hours => $2))`,
        [RENEW_LEAD_DAYS, RENEW_RETRY_HOURS]
    );
    for (const row of manual.rows) {
        const mod = moduleById.get(row.module_id);
        if (!mod) continue;
        try {
            await db.query(
                `UPDATE module_purchases SET last_renewal_at = NOW() WHERE store_id = $1 AND module_id = $2`,
                [row.store_id, row.module_id]
            );
            await pushToStore(row.store_id, `${mod.name} expires soon`, `Auto-renew is off. Renew ${mod.name} in SalePilot to avoid losing it.`);
            actions++;
        } catch (e: any) {
            console.warn(`[renewal] manual reminder failed for ${row.store_id}/${row.module_id}:`, e.message);
        }
    }

    if (actions) console.log(`[renewal] processed ${actions} add-on renewal action(s).`);
    return actions;
};
