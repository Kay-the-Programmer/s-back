import { MODULES, ModuleId } from './entitlements.service';

/**
 * Packaging model: **paid product, every feature in every tier**.
 *
 * SalePilot was free core plus a-la-carte add-ons. It is now paid-only with a
 * 7-day trial, and all three tiers include every feature — they differ on
 * capacity (shops, seats, products, AI), which lives in `plan-limits.ts`.
 *
 * The entitlement machinery below is kept rather than deleted: paying for any
 * tier grants every module, so the per-feature gates still resolve correctly
 * (subscribed = unlocked, lapsed = revoked) and the ladder can be re-tiered
 * later without rebuilding it.
 */
export const PLAN_MODULES: Record<string, ModuleId[]> = {
    // Every tier includes every feature — see ALL_MODULES below. The tiers
    // differ on capacity (shops, seats, products, AI), which lives in
    // plan-limits.ts. These lists are kept only so an older database row or a
    // Super Admin edit still resolves to something sensible.
    plan_basic: [],
    plan_pro: [],
    plan_enterprise: [],
};

/** Every premium module — the "taste everything" set used during the intro trial. */
export const ALL_MODULES: ModuleId[] = Object.values(MODULES);

/** Modules a brand-new store gets to try for free during the intro trial. */
export const TRIAL_MODULES: ModuleId[] = ALL_MODULES;

/**
 * Length of the free trial, in days. The whole app is on trial now, not just
 * the add-ons, so this is the only free period a shop gets.
 */
export const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);

/**
 * Days of grace after `subscription_ends_at` before the shop is locked out.
 *
 * Nothing is free after the trial, so this is what stops a till dying mid
 * trading day over a mobile-money payment that has not cleared yet. The app
 * keeps working and warns during these days; past them it locks.
 */
export const GRACE_DAYS = parseInt(process.env.SUBSCRIPTION_GRACE_DAYS || '3', 10);

/**
 * Modules granted by a plan. Every known tier grants everything, because the
 * tiers differ on capacity rather than features. An unrecognised plan id still
 * gets the full set: a store that has paid for something should never be left
 * half-working because its plan row is stale.
 */
export const modulesForPlan = (planId?: string | null): ModuleId[] =>
    planId ? [...ALL_MODULES] : [];
