import db from '../db_client';
import { GRACE_DAYS } from './plan-modules';
import { invalidateUserCache } from '../middleware/auth.middleware';
import { modulesForPlan as catalogModulesForPlan } from './catalog.service';
import { removeEnabledModules } from './entitlements.service';
import { getActivePurchasedModuleIds } from './module-purchase.service';

/**
 * Subscription lifecycle enforcement (the freemium funnel's teeth).
 *
 * Without this, a store that signs up on a `trial` — or pays once — keeps
 * premium access forever, because nothing ever reads the access window.
 *
 * Two passes, both *surgical* (they only remove the specific modules that
 * lapsed, leaving à-la-carte purchases and superadmin grants intact):
 *   1. Plan/trial lapse: store past `subscription_ends_at` -> `past_due`, and
 *      its plan modules are revoked unless still covered by an active à-la-carte
 *      purchase.
 *   2. Add-on expiry: an à-la-carte `module_purchases` row past its period is
 *      marked expired and its module revoked, unless an active plan still grants it.
 *
 * Core POS stays free and fully usable throughout; only paid add-ons lock.
 */

const bustStoreCache = async (storeId: string): Promise<string[]> => {
    const users = await db.query('SELECT id FROM users WHERE current_store_id = $1', [storeId]);
    const ids = users.rows.map((u: any) => u.id as string);
    ids.forEach(invalidateUserCache);
    return ids;
};

const notify = async (userIds: string[], title: string, body: string) => {
    if (userIds.length === 0) return;
    try {
        const { pushService } = await import('./push.service');
        await pushService.sendToUsers(userIds, { title, body, url: '/settings/subscription' }).catch(() => {});
    } catch { /* best effort */ }
};

export const runSubscriptionLifecycle = async (): Promise<number> => {
    let processed = 0;

    // --- Pass 1: plan / trial lapse ------------------------------------------
    const expired = await db.query(
        `SELECT id, subscription_status, subscription_plan
           FROM stores
          WHERE subscription_status IN ('trial', 'active')
            AND subscription_ends_at IS NOT NULL
            AND subscription_ends_at < (NOW() - make_interval(days => $1))`,
        [GRACE_DAYS]
    );

    for (const store of expired.rows) {
        const storeId = store.id as string;
        try {
            const planMods = await catalogModulesForPlan(store.subscription_plan);
            const stillPurchased = new Set(await getActivePurchasedModuleIds(storeId));
            const toRevoke = planMods.filter(m => !stillPurchased.has(m));

            await db.query('BEGIN');
            await db.query(
                `UPDATE stores SET subscription_status = 'past_due', updated_at = NOW() WHERE id = $1`,
                [storeId]
            );
            await db.query('COMMIT');
            if (toRevoke.length) await removeEnabledModules(storeId, toRevoke);
            processed++;
        } catch (e: any) {
            await db.query('ROLLBACK').catch(() => {});
            console.error(`[lifecycle] failed plan lapse for store ${storeId}:`, e.message);
            continue;
        }

        try {
            const userIds = await bustStoreCache(storeId);
            const wasTrial = store.subscription_status === 'trial';
            await notify(
                userIds,
                wasTrial ? 'Your free trial has ended' : 'Your subscription has expired',
                wasTrial
                    ? 'Plan add-ons are now locked. Your core POS keeps working — subscribe to switch them back on.'
                    : 'Plan add-ons are now locked. Renew to restore your included add-ons.',
            );
        } catch (e: any) {
            console.warn(`[lifecycle] notify failed for ${storeId}:`, e.message);
        }
    }

    // --- Pass 2: à-la-carte add-on expiry ------------------------------------
    const expiredAddons = await db.query(
        `SELECT mp.store_id, mp.module_id, s.subscription_status, s.subscription_plan, s.subscription_ends_at
           FROM module_purchases mp
           JOIN stores s ON s.id = mp.store_id
          WHERE mp.status = 'active'
            AND mp.current_period_end < (NOW() - make_interval(days => $1))`,
        [GRACE_DAYS]
    );

    for (const row of expiredAddons.rows) {
        const storeId = row.store_id as string;
        try {
            await db.query(
                `UPDATE module_purchases SET status = 'expired', updated_at = NOW() WHERE store_id = $1 AND module_id = $2`,
                [storeId, row.module_id]
            );
            // Keep the module only if an active plan still grants it.
            const planActive = (row.subscription_status === 'active' || row.subscription_status === 'trial')
                && (!row.subscription_ends_at || new Date(row.subscription_ends_at) > new Date());
            const planMods = planActive ? await catalogModulesForPlan(row.subscription_plan) : [];
            if (!planMods.includes(row.module_id)) {
                await removeEnabledModules(storeId, [row.module_id]);
                const userIds = await bustStoreCache(storeId);
                await notify(userIds, 'An add-on expired', 'A paid add-on has lapsed. Renew it any time from your subscription page.');
            }
            processed++;
        } catch (e: any) {
            console.error(`[lifecycle] failed add-on expiry for ${storeId}/${row.module_id}:`, e.message);
            continue;
        }
    }

    if (processed) console.log(`[lifecycle] reconciled ${processed} expiry event(s).`);
    return processed;
};
