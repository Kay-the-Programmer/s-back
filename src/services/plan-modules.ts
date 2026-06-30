import { MODULES, ModuleId } from './entitlements.service';

/**
 * Packaging model: **free core + paid add-on modules**.
 *
 * Core POS (sales, inventory, categories, basic reports, settings, account) is
 * free forever and is NEVER listed here. Everything in this file is premium —
 * a store only gets a module by paying (or during the intro trial).
 *
 * The legacy Basic/Pro/Enterprise plan ids are kept as **presets**: named
 * bundles that map onto a set of add-on modules. Paying for a plan grants that
 * plan's module set; this is the single source of truth that reconciles the
 * old tier-based checkout with the new entitlement system.
 */
export const PLAN_MODULES: Record<string, ModuleId[]> = {
    // Starter — core only, no premium add-ons.
    plan_basic: [],
    // Growth — the everyday upgrade bundle.
    plan_pro: [
        MODULES.TEAM_MEMBERS,
        MODULES.AUTO_REORDER,
        MODULES.QUICK_IMPORT,
        MODULES.ADVANCED_REPORTS,
        MODULES.AI_ASSISTANT,
        MODULES.UNLIMITED_PRODUCTS,
    ],
    // Full — every add-on unlocked.
    plan_enterprise: [
        MODULES.TEAM_MEMBERS,
        MODULES.AUTO_REORDER,
        MODULES.QUICK_IMPORT,
        MODULES.ADVANCED_REPORTS,
        MODULES.AI_ASSISTANT,
        MODULES.SMS_MESSAGING,
        MODULES.WHATSAPP_MESSAGING,
        MODULES.SOCIAL_MARKETING,
        MODULES.PUBLIC_TRACKING,
        MODULES.UNLIMITED_PRODUCTS,
    ],
};

/** Every premium module — the "taste everything" set used during the intro trial. */
export const ALL_MODULES: ModuleId[] = Object.values(MODULES);

/** Modules a brand-new store gets to try for free during the intro trial. */
export const TRIAL_MODULES: ModuleId[] = ALL_MODULES;

/** Length of the free intro trial of premium add-ons, in days. */
export const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);

/**
 * Days of grace after `subscription_ends_at` before premium add-ons are revoked.
 * Core stays free regardless; this only affects paid modules.
 */
export const GRACE_DAYS = parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '0', 10);

/** Modules granted by a given plan id (empty for unknown/free). */
export const modulesForPlan = (planId?: string | null): ModuleId[] =>
    (planId && PLAN_MODULES[planId]) ? [...PLAN_MODULES[planId]] : [];
