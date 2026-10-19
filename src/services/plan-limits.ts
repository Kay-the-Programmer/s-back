import db from '../db_client';
import { getEffectivePlan } from './subscription.service';

/**
 * Packaging model: **paid-only, every feature in every tier**.
 *
 * SalePilot used to be free core plus à-la-carte add-ons. It is now a paid
 * product with a 7-day trial, and the three tiers no longer differ on
 * *features* — a Basic store can do everything an Enterprise store can. They
 * differ on **capacity**: how many shops, how many staff logins, how many
 * products, how much AI. That is the only honest way to keep a ladder once
 * every feature is included, and it is the dimension a growing shop actually
 * notices.
 *
 * `-1` means unlimited. These are defaults; the Super Admin catalogue can
 * override any of them per plan (see `catalog_plans.limits`), so pricing can
 * move without a deploy.
 */
export interface PlanLimits {
    /** Shops one owner may run on this tier. */
    stores: number;
    /** User logins in a shop, the owner included — so 2 means owner + cashier. */
    seats: number;
    /** Products in a shop's catalogue. */
    products: number;
    /** AI requests per month (mirrors catalog_plans.ai_requests_limit). */
    aiRequests: number;
}

/** Capacity per tier. Features are identical across all three. */
export const PLAN_LIMITS: Record<string, PlanLimits> = {
    // One shop, owner + one cashier. The cashier is deliberately included:
    // a single till with one member of staff is the typical customer, and
    // charging extra for the second login made the receipt's "attended by",
    // till sessions and manager overrides unusable for exactly those shops.
    plan_basic: { stores: 1, seats: 2, products: 500, aiRequests: 50 },
    // One shop, a full shift of staff, no catalogue ceiling.
    plan_pro: { stores: 1, seats: 6, products: -1, aiRequests: 500 },
    // Several shops, no ceilings anywhere.
    plan_enterprise: { stores: -1, seats: -1, products: -1, aiRequests: -1 },
};

/** What an unknown or missing plan gets: the entry tier's capacity. */
export const DEFAULT_LIMITS: PlanLimits = PLAN_LIMITS.plan_basic;

/** Whether a limit allows one more of something. */
export const withinLimit = (used: number, limit: number): boolean =>
    limit === -1 || used < limit;

/** How a limit reads to a shopkeeper. */
export const describeLimit = (limit: number): string => (limit === -1 ? 'unlimited' : String(limit));

/**
 * Capacity for a plan id. The catalogue is consulted first so a Super Admin
 * can retune a tier without a deploy; the constants above are the fallback.
 */
export const limitsForPlan = async (planId?: string | null): Promise<PlanLimits> => {
    const base = (planId && PLAN_LIMITS[planId]) ? { ...PLAN_LIMITS[planId] } : { ...DEFAULT_LIMITS };
    if (!planId) return base;
    try {
        const plan: any = await getEffectivePlan(planId);
        // Super Admin edits to the AI allowance already live on the plan row;
        // honour them so there is one source of truth for that number.
        if (plan && typeof plan.aiRequestsLimit === 'number') base.aiRequests = plan.aiRequestsLimit;
        if (plan && plan.limits && typeof plan.limits === 'object') {
            for (const key of ['stores', 'seats', 'products'] as const) {
                const v = Number(plan.limits[key]);
                if (Number.isFinite(v)) base[key] = v;
            }
        }
    } catch {
        // Catalogue unreachable — the constants are a safe floor.
    }
    return base;
};

/** Capacity for the plan a store is on. */
export const limitsForStore = async (storeId?: string | null): Promise<PlanLimits> => {
    if (!storeId) return { ...DEFAULT_LIMITS };
    try {
        const res = await db.query('SELECT subscription_plan FROM stores WHERE id = $1', [storeId]);
        return limitsForPlan(res.rows[0]?.subscription_plan);
    } catch {
        return { ...DEFAULT_LIMITS };
    }
};

/** Capacity for the plan a store owner's portfolio sits on (for the store cap). */
export const limitsForOwner = async (ownerId?: string | null): Promise<PlanLimits> => {
    if (!ownerId) return { ...DEFAULT_LIMITS };
    try {
        // The most generous plan the owner holds decides how many shops they
        // may run, so paying for Enterprise on one shop is not undone by an
        // older Basic shop sitting alongside it.
        const res = await db.query(
            `SELECT subscription_plan FROM stores
              WHERE owner_id = $1 AND subscription_status IN ('trial', 'active')`,
            [ownerId],
        );
        if (res.rowCount === 0) return { ...DEFAULT_LIMITS };
        const all = await Promise.all(res.rows.map(r => limitsForPlan(r.subscription_plan)));
        return all.reduce((best, l) => {
            if (best.stores === -1 || l.stores === -1) return l.stores === -1 ? l : best;
            return l.stores > best.stores ? l : best;
        });
    } catch {
        return { ...DEFAULT_LIMITS };
    }
};
