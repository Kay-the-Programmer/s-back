import db from '../db_client';

/**
 * Premium add-on entitlements (modular packaging). The runtime source of truth
 * is `store_settings.enabled_modules`. Features default to LOCKED — a store must
 * have the module granted (after paying) before the feature works.
 */
export const MODULES = {
    SMS_MESSAGING: 'sms_messaging',
    WHATSAPP_MESSAGING: 'whatsapp_messaging',
    SOCIAL_MARKETING: 'social_marketing',
    TEAM_MEMBERS: 'team_members',
    AUTO_REORDER: 'auto_reorder',
    AI_ASSISTANT: 'ai_assistant',
    QUICK_IMPORT: 'quick_import',
    ADVANCED_REPORTS: 'advanced_reports',
    PUBLIC_TRACKING: 'public_tracking',
    UNLIMITED_PRODUCTS: 'unlimited_products',
    PAYMENT_GATEWAY: 'payment_gateway',
} as const;

export type ModuleId = typeof MODULES[keyof typeof MODULES];

/** User seats included for free (the owner). Extra seats need TEAM_MEMBERS. */
export const FREE_SEATS = 1;

/** Products allowed on the free core. Going beyond needs UNLIMITED_PRODUCTS. */
export const FREE_PRODUCT_LIMIT = parseInt(process.env.FREE_PRODUCT_LIMIT || '100', 10);

/** All modules currently granted to a store (empty when none / unknown). */
export const getEnabledModules = async (storeId?: string | null): Promise<string[]> => {
    if (!storeId) return [];
    try {
        const result = await db.query('SELECT enabled_modules FROM store_settings WHERE store_id = $1', [storeId]);
        const mods = result.rows[0]?.enabled_modules;
        return Array.isArray(mods) ? mods : [];
    } catch (e: any) {
        // Column missing on an un-migrated DB — fail closed (treat as locked).
        console.warn('[entitlements] could not read enabled_modules (treating as locked):', e.message);
        return [];
    }
};

/**
 * Whether a store may use a given feature.
 *
 * Every tier includes every feature now, so the real question is simply
 * "is this shop paid up?" — and that is answered from the subscription, NOT
 * from `enabled_modules`. Reading the column would mean a store that has paid
 * loses features whenever the column drifts: it is only written at checkout
 * and at trial start, the lifecycle job clears it on a lapse, and a store
 * created or repaired by any other path never had it filled in at all.
 * Entitlement has to follow the money, not a cache of it.
 *
 * `enabled_modules` is still honoured as a grant on top, so a Super Admin can
 * hand a specific feature to a store that is not currently subscribed.
 */
export const isModuleEnabled = async (storeId: string | null | undefined, moduleId: string): Promise<boolean> => {
    if (!storeId) return false;
    if (await isStoreSubscribed(storeId)) return true;
    const mods = await getEnabledModules(storeId);
    return mods.includes(moduleId);
};

/**
 * Whether a store's subscription currently entitles it to the product: on
 * trial or paid, and not past its end date plus the grace days.
 *
 * Computed from the dates rather than trusting `subscription_status` alone, so
 * a late lifecycle job cannot hand out free months and an early one cannot cut
 * a shop off inside its grace. Mirrors the access gate in auth.middleware.
 */
export const isStoreSubscribed = async (storeId?: string | null): Promise<boolean> => {
    if (!storeId) return false;
    try {
        const { GRACE_DAYS } = await import('./plan-modules');
        const res = await db.query(
            'SELECT subscription_status, subscription_ends_at FROM stores WHERE id = $1',
            [storeId],
        );
        const row = res.rows[0];
        if (!row) return false;
        if (row.subscription_status === 'canceled') return false;
        if (!row.subscription_ends_at) {
            // No end date: an open-ended store (legacy or platform-granted).
            return row.subscription_status === 'active' || row.subscription_status === 'trial';
        }
        const lockedAt = new Date(row.subscription_ends_at).getTime() + GRACE_DAYS * 86400000;
        return Date.now() <= lockedAt;
    } catch (e: any) {
        console.warn('[entitlements] could not read subscription (treating as unsubscribed):', e.message);
        return false;
    }
};

/** Replace a store's granted modules (superadmin-controlled "unlock at a fee"). */
export const setEnabledModules = async (storeId: string, modules: string[]): Promise<string[]> => {
    const clean = Array.from(new Set((modules || []).filter(m => typeof m === 'string' && m.trim()).map(m => m.trim())));
    await db.query('UPDATE store_settings SET enabled_modules = $1 WHERE store_id = $2', [clean, storeId]);
    return clean;
};

/** Add modules to a store's granted set (union) — used when an add-on is purchased. */
export const addEnabledModules = async (storeId: string, modules: string[]): Promise<string[]> => {
    const current = await getEnabledModules(storeId);
    const next = Array.from(new Set([...current, ...(modules || []).filter(m => typeof m === 'string' && m.trim())]));
    await db.query('UPDATE store_settings SET enabled_modules = $1 WHERE store_id = $2', [next, storeId]);
    return next;
};

/** Remove specific modules from a store's granted set (leaves everything else intact). */
export const removeEnabledModules = async (storeId: string, modules: string[]): Promise<string[]> => {
    const current = await getEnabledModules(storeId);
    const remove = new Set(modules || []);
    const next = current.filter(m => !remove.has(m));
    await db.query('UPDATE store_settings SET enabled_modules = $1 WHERE store_id = $2', [next, storeId]);
    return next;
};
