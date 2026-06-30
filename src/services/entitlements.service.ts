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

/** Whether a specific module is granted to the store. */
export const isModuleEnabled = async (storeId: string | null | undefined, moduleId: string): Promise<boolean> => {
    const mods = await getEnabledModules(storeId);
    return mods.includes(moduleId);
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
