import db from '../db_client';
import { MODULES } from './entitlements.service';
import { PLAN_MODULES } from './plan-modules';

/**
 * Configurable commerce catalog — the single source of truth for add-on module
 * prices, subscription plans, the pages each module unlocks, and whether a
 * module can be bought à la carte. Persisted in `catalog_modules` /
 * `catalog_plans` and edited by the Super Admin.
 *
 * Everything falls back to the seed constants below if the tables are empty or
 * unavailable, so behavior is identical until a Super Admin changes something.
 */

export interface CatalogModule {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    pages: string[];
    independentlyPurchasable: boolean;
    isCore: boolean;
    active: boolean;
    sortOrder: number;
}

export interface CatalogPlan {
    id: string;
    name: string;
    description: string;
    price: number;
    currency: string;
    interval: 'month' | 'year';
    moduleIds: string[];
    features: string[];
    aiRequestsLimit: number; // -1 = unlimited
    isPopular: boolean;
    active: boolean;
    sortOrder: number;
}

// --- Seed data (mirrors the legacy constants; only inserted when empty) -------

const MODULE_SEED: CatalogModule[] = [
    { id: MODULES.AI_ASSISTANT,    name: 'AI Assistant',             description: 'AI business advisor, data chat, product descriptions and forecasting.', price: 120, currency: 'ZMW', pages: ['quick-view'], independentlyPurchasable: true, isCore: false, active: true, sortOrder: 1 },
    { id: MODULES.ADVANCED_REPORTS, name: 'Advanced Reports',         description: 'Full analytics: profit, channels, trends and exports.',                  price: 70,  currency: 'ZMW', pages: ['reports'],    independentlyPurchasable: true, isCore: false, active: true, sortOrder: 2 },
    { id: MODULES.TEAM_MEMBERS,    name: 'Team Members',             description: 'Add staff accounts with role-based permissions (beyond the free seat).', price: 60,  currency: 'ZMW', pages: [],             independentlyPurchasable: true, isCore: false, active: true, sortOrder: 3 },
    { id: MODULES.AUTO_REORDER,    name: 'Auto Reorder & POs',       description: 'Auto-generate purchase orders from low-stock alerts.',                    price: 80,  currency: 'ZMW', pages: [],             independentlyPurchasable: true, isCore: false, active: true, sortOrder: 4 },
    { id: MODULES.QUICK_IMPORT,    name: 'Quick Import',             description: 'Bulk-import products and build purchase orders from lists fast.',         price: 40,  currency: 'ZMW', pages: [],             independentlyPurchasable: true, isCore: false, active: true, sortOrder: 5 },
    { id: MODULES.SMS_MESSAGING,   name: 'SMS Messaging',            description: 'Send SMS to customers directly from the app.',                            price: 90,  currency: 'ZMW', pages: [],             independentlyPurchasable: true, isCore: false, active: true, sortOrder: 6 },
    { id: MODULES.WHATSAPP_MESSAGING, name: 'WhatsApp Messaging',     description: 'Chat with customers on WhatsApp Business — two-way inbox right inside the CRM.', price: 110, currency: 'ZMW', pages: [],         independentlyPurchasable: true, isCore: false, active: true, sortOrder: 7 },
    { id: MODULES.SOCIAL_MARKETING, name: 'Social Marketing',        description: 'Manage your Facebook Page — publish posts, moderate comments and see engagement insights.', price: 120, currency: 'ZMW', pages: ['marketing'], independentlyPurchasable: true, isCore: false, active: true, sortOrder: 8 },
    { id: MODULES.PUBLIC_TRACKING, name: 'Public Shipment Tracking', description: 'Let customers track their deliveries via a public link.',                 price: 50,  currency: 'ZMW', pages: [],             independentlyPurchasable: true, isCore: false, active: true, sortOrder: 9 },
    { id: MODULES.UNLIMITED_PRODUCTS, name: 'Unlimited Products',    description: 'Remove the free 100-product limit — add as many products as you like.',   price: 100, currency: 'ZMW', pages: [],             independentlyPurchasable: true, isCore: false, active: true, sortOrder: 10 },
];

/** Module that, when present in a store's entitlements, lifts the free product cap. */
const UNLIMITED_PRODUCTS_SEED = MODULE_SEED[MODULE_SEED.length - 1];

/** WhatsApp add-on — backfilled into already-seeded catalogs (see seed step). */
const WHATSAPP_MESSAGING_SEED = MODULE_SEED.find(m => m.id === MODULES.WHATSAPP_MESSAGING)!;

/** Social Marketing add-on — backfilled into already-seeded catalogs. */
const SOCIAL_MARKETING_SEED = MODULE_SEED.find(m => m.id === MODULES.SOCIAL_MARKETING)!;

const PLAN_SEED: CatalogPlan[] = [
    {
        id: 'plan_basic', name: 'Basic', description: 'Essential features for small businesses',
        price: 99, currency: 'ZMW', interval: 'month',
        moduleIds: [...(PLAN_MODULES.plan_basic || [])],
        features: ['Up to 100 Products', 'Basic Sales Reports', '1 User Account', 'Email Support'],
        aiRequestsLimit: 50, isPopular: false, active: true, sortOrder: 1,
    },
    {
        id: 'plan_pro', name: 'Pro', description: 'Advanced tools for growing stores',
        price: 249, currency: 'ZMW', interval: 'month',
        moduleIds: [...(PLAN_MODULES.plan_pro || [])],
        features: ['Unlimited Products', 'Advanced Analytics', 'Up to 5 User Accounts', '500 AI Requests/month', 'Inventory Alerts', 'Priority Support'],
        aiRequestsLimit: 500, isPopular: true, active: true, sortOrder: 2,
    },
    {
        id: 'plan_enterprise', name: 'Enterprise', description: 'Complete solution for large operations',
        price: 599, currency: 'ZMW', interval: 'month',
        moduleIds: [...(PLAN_MODULES.plan_enterprise || [])],
        features: ['Unlimited Everything', 'Custom Reports', 'Unlimited AI Requests', 'Dedicated Account Manager', 'API Access', 'Multi-store Management'],
        aiRequestsLimit: -1, isPopular: false, active: true, sortOrder: 3,
    },
];

// --- Schema + seeding --------------------------------------------------------

let seeded = false;

export const ensureCatalogSeeded = async (): Promise<void> => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS catalog_modules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price NUMERIC(10,2) NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'ZMW',
            pages TEXT[] NOT NULL DEFAULT '{}',
            independently_purchasable BOOLEAN NOT NULL DEFAULT TRUE,
            is_core BOOLEAN NOT NULL DEFAULT FALSE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await db.query(`
        CREATE TABLE IF NOT EXISTS catalog_plans (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            price NUMERIC(10,2) NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'ZMW',
            interval TEXT NOT NULL DEFAULT 'month',
            module_ids TEXT[] NOT NULL DEFAULT '{}',
            features TEXT[] NOT NULL DEFAULT '{}',
            ai_requests_limit INT NOT NULL DEFAULT 0,
            is_popular BOOLEAN NOT NULL DEFAULT FALSE,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // À-la-carte add-on purchases: each row is one module's paid billing period
    // for a store, so independently-bought modules expire on their own schedule.
    await db.query(`
        CREATE TABLE IF NOT EXISTS module_purchases (
            store_id TEXT NOT NULL,
            module_id TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'active',
            current_period_end TIMESTAMPTZ NOT NULL,
            price NUMERIC(10,2) NOT NULL DEFAULT 0,
            currency TEXT NOT NULL DEFAULT 'ZMW',
            reference TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (store_id, module_id)
        );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_module_purchases_period ON module_purchases(status, current_period_end);`);
    // Auto-renew tracking for à-la-carte add-ons.
    await db.query(`ALTER TABLE module_purchases ADD COLUMN IF NOT EXISTS auto_renew BOOLEAN NOT NULL DEFAULT TRUE;`);
    await db.query(`ALTER TABLE module_purchases ADD COLUMN IF NOT EXISTS renewal_attempts INT NOT NULL DEFAULT 0;`);
    await db.query(`ALTER TABLE module_purchases ADD COLUMN IF NOT EXISTS last_renewal_at TIMESTAMPTZ;`);
    await db.query(`ALTER TABLE module_purchases ADD COLUMN IF NOT EXISTS last_renewal_reference TEXT;`);
    // Tag subscription_payments rows that are add-on purchases (vs plan payments).
    await db.query(`ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS module_ids TEXT[];`);
    // Billing cycle for plan payments ('monthly' | 'annual') — drives the period extended.
    await db.query(`ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS billing_cycle TEXT;`);
    // Plan auto-renew / dunning tracking on the store.
    await db.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS plan_auto_renew BOOLEAN NOT NULL DEFAULT TRUE;`);
    await db.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_billing_cycle TEXT;`);
    await db.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS plan_renewal_attempts INT NOT NULL DEFAULT 0;`);
    await db.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS plan_last_renewal_at TIMESTAMPTZ;`);
    await db.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS plan_last_renewal_reference TEXT;`);

    const mCount = await db.query('SELECT COUNT(*)::int AS n FROM catalog_modules');
    if (mCount.rows[0].n === 0) {
        for (const m of MODULE_SEED) await writeModule(m);
        console.log(`[catalog] seeded ${MODULE_SEED.length} add-on modules.`);
    } else {
        // Idempotently add the Unlimited Products add-on to already-seeded DBs
        // (without overwriting any admin edits to existing modules).
        const exists = await db.query('SELECT 1 FROM catalog_modules WHERE id = $1', [UNLIMITED_PRODUCTS_SEED.id]);
        if (exists.rowCount === 0) {
            await writeModule(UNLIMITED_PRODUCTS_SEED);
            console.log('[catalog] added Unlimited Products add-on to existing catalog.');
        }
        // Likewise backfill the WhatsApp Messaging add-on for the CRM.
        const waExists = await db.query('SELECT 1 FROM catalog_modules WHERE id = $1', [WHATSAPP_MESSAGING_SEED.id]);
        if (waExists.rowCount === 0) {
            await writeModule(WHATSAPP_MESSAGING_SEED);
            console.log('[catalog] added WhatsApp Messaging add-on to existing catalog.');
        }
        // And the Social Marketing (Facebook Pages) add-on.
        const smExists = await db.query('SELECT 1 FROM catalog_modules WHERE id = $1', [SOCIAL_MARKETING_SEED.id]);
        if (smExists.rowCount === 0) {
            await writeModule(SOCIAL_MARKETING_SEED);
            console.log('[catalog] added Social Marketing add-on to existing catalog.');
        }
    }
    const pCount = await db.query('SELECT COUNT(*)::int AS n FROM catalog_plans');
    if (pCount.rows[0].n === 0) {
        for (const p of PLAN_SEED) await writePlan(p);
        console.log(`[catalog] seeded ${PLAN_SEED.length} subscription plans.`);
    }
    seeded = true;
    invalidateCache();
};

// --- Row mapping -------------------------------------------------------------

const toModule = (r: any): CatalogModule => ({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    price: parseFloat(r.price) || 0,
    currency: r.currency || 'ZMW',
    pages: Array.isArray(r.pages) ? r.pages : [],
    independentlyPurchasable: !!r.independently_purchasable,
    isCore: !!r.is_core,
    active: !!r.active,
    sortOrder: r.sort_order ?? 0,
});

const toPlan = (r: any): CatalogPlan => ({
    id: r.id,
    name: r.name,
    description: r.description ?? '',
    price: parseFloat(r.price) || 0,
    currency: r.currency || 'ZMW',
    interval: (r.interval === 'year' ? 'year' : 'month'),
    moduleIds: Array.isArray(r.module_ids) ? r.module_ids : [],
    features: Array.isArray(r.features) ? r.features : [],
    aiRequestsLimit: typeof r.ai_requests_limit === 'number' ? r.ai_requests_limit : parseInt(r.ai_requests_limit ?? '0', 10),
    isPopular: !!r.is_popular,
    active: !!r.active,
    sortOrder: r.sort_order ?? 0,
});

// --- Tiny cache (invalidated on every write) ---------------------------------

let moduleCache: CatalogModule[] | null = null;
let planCache: CatalogPlan[] | null = null;
const invalidateCache = () => { moduleCache = null; planCache = null; };

const loadModules = async (): Promise<CatalogModule[]> => {
    if (moduleCache) return moduleCache;
    try {
        const res = await db.query('SELECT * FROM catalog_modules ORDER BY sort_order, name');
        moduleCache = res.rows.map(toModule);
    } catch (e: any) {
        console.warn('[catalog] module read failed, using seed fallback:', e.message);
        return MODULE_SEED;
    }
    return moduleCache.length ? moduleCache : MODULE_SEED;
};

const loadPlans = async (): Promise<CatalogPlan[]> => {
    if (planCache) return planCache;
    try {
        const res = await db.query('SELECT * FROM catalog_plans ORDER BY sort_order, price');
        planCache = res.rows.map(toPlan);
    } catch (e: any) {
        console.warn('[catalog] plan read failed, using seed fallback:', e.message);
        return PLAN_SEED;
    }
    return planCache.length ? planCache : PLAN_SEED;
};

// --- Reads -------------------------------------------------------------------

export const getModules = async (includeInactive = false): Promise<CatalogModule[]> => {
    const all = await loadModules();
    return includeInactive ? all : all.filter(m => m.active);
};

export const getModule = async (id: string): Promise<CatalogModule | undefined> =>
    (await loadModules()).find(m => m.id === id);

export const getPlans = async (includeInactive = false): Promise<CatalogPlan[]> => {
    const all = await loadPlans();
    return includeInactive ? all : all.filter(p => p.active);
};

export const getPlan = async (id: string): Promise<CatalogPlan | undefined> =>
    (await loadPlans()).find(p => p.id === id);

/** Module ids a plan grants (falls back to the static preset map). */
export const modulesForPlan = async (planId?: string | null): Promise<string[]> => {
    if (!planId) return [];
    const plan = await getPlan(planId);
    if (plan) return [...plan.moduleIds];
    return [...(PLAN_MODULES[planId] || [])];
};

/** Monthly AI request allowance for a plan (-1 unlimited; 0 when unknown). */
export const getPlanAiLimit = async (planId?: string | null): Promise<number> => {
    if (!planId) return 0;
    const plan = await getPlan(planId);
    return plan ? plan.aiRequestsLimit : 0;
};

/** Page-key -> module-id map for entitlement gating (only non-core, gated pages). */
export const getPageModuleMap = async (): Promise<Record<string, string>> => {
    const map: Record<string, string> = {};
    for (const m of await loadModules()) {
        if (m.isCore) continue;
        for (const page of m.pages) map[page] = m.id;
    }
    return map;
};

// --- Writes (Super Admin) ----------------------------------------------------

const writeModule = async (m: CatalogModule): Promise<void> => {
    await db.query(
        `INSERT INTO catalog_modules (id, name, description, price, currency, pages, independently_purchasable, is_core, active, sort_order, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, description = EXCLUDED.description, price = EXCLUDED.price,
            currency = EXCLUDED.currency, pages = EXCLUDED.pages,
            independently_purchasable = EXCLUDED.independently_purchasable,
            is_core = EXCLUDED.is_core, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order,
            updated_at = NOW()`,
        [m.id, m.name, m.description, m.price, m.currency, m.pages, m.independentlyPurchasable, m.isCore, m.active, m.sortOrder]
    );
};

const writePlan = async (p: CatalogPlan): Promise<void> => {
    await db.query(
        `INSERT INTO catalog_plans (id, name, description, price, currency, interval, module_ids, features, ai_requests_limit, is_popular, active, sort_order, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
         ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name, description = EXCLUDED.description, price = EXCLUDED.price,
            currency = EXCLUDED.currency, interval = EXCLUDED.interval, module_ids = EXCLUDED.module_ids,
            features = EXCLUDED.features, ai_requests_limit = EXCLUDED.ai_requests_limit,
            is_popular = EXCLUDED.is_popular, active = EXCLUDED.active, sort_order = EXCLUDED.sort_order,
            updated_at = NOW()`,
        [p.id, p.name, p.description, p.price, p.currency, p.interval, p.moduleIds, p.features, p.aiRequestsLimit, p.isPopular, p.active, p.sortOrder]
    );
};

const slugify = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `mod_${Date.now()}`;

export const upsertModule = async (input: Partial<CatalogModule> & { name: string }): Promise<CatalogModule> => {
    const existing = input.id ? await getModule(input.id) : undefined;
    const module: CatalogModule = {
        id: input.id || slugify(input.name),
        name: input.name,
        description: input.description ?? existing?.description ?? '',
        price: input.price ?? existing?.price ?? 0,
        currency: input.currency ?? existing?.currency ?? 'ZMW',
        pages: input.pages ?? existing?.pages ?? [],
        independentlyPurchasable: input.independentlyPurchasable ?? existing?.independentlyPurchasable ?? true,
        isCore: input.isCore ?? existing?.isCore ?? false,
        active: input.active ?? existing?.active ?? true,
        sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
    };
    await writeModule(module);
    invalidateCache();
    return module;
};

export const deleteModule = async (id: string): Promise<void> => {
    await db.query('DELETE FROM catalog_modules WHERE id = $1', [id]);
    invalidateCache();
};

export const upsertPlan = async (input: Partial<CatalogPlan> & { name: string }): Promise<CatalogPlan> => {
    const existing = input.id ? await getPlan(input.id) : undefined;
    const plan: CatalogPlan = {
        id: input.id || `plan_${slugify(input.name)}`,
        name: input.name,
        description: input.description ?? existing?.description ?? '',
        price: input.price ?? existing?.price ?? 0,
        currency: input.currency ?? existing?.currency ?? 'ZMW',
        interval: input.interval ?? existing?.interval ?? 'month',
        moduleIds: input.moduleIds ?? existing?.moduleIds ?? [],
        features: input.features ?? existing?.features ?? [],
        aiRequestsLimit: input.aiRequestsLimit ?? existing?.aiRequestsLimit ?? 0,
        isPopular: input.isPopular ?? existing?.isPopular ?? false,
        active: input.active ?? existing?.active ?? true,
        sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
    };
    await writePlan(plan);
    invalidateCache();
    return plan;
};

export const deletePlan = async (id: string): Promise<void> => {
    await db.query('DELETE FROM catalog_plans WHERE id = $1', [id]);
    invalidateCache();
};

export const catalogReady = () => seeded;
