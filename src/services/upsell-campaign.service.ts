import db from '../db_client';

/**
 * Super-Admin-authored upsell *campaigns* — the configurable marketing layer on
 * top of the client's built-in upsell moments. Each row either OVERRIDES a
 * built-in moment (same id — retune copy / offer / schedule / A-B / pause it) or
 * adds a BRAND-NEW campaign. The client merges these over its compiled built-in
 * defaults by id (see `utils/upsell.ts` → `resolveCampaigns`), so an empty table
 * means "behave exactly like the shipped defaults".
 *
 * Persisted in `upsell_campaigns`. Modelled on `catalog.service.ts`: a tiny
 * cache invalidated on every write, and read fallbacks that never throw so a
 * transient DB hiccup can't break the engine (the client also has its own
 * built-in fallback).
 */

export type UpsellSurface = 'paywall' | 'discover_card' | 'daily_summary' | 'inline_card' | 'push';
export type LifecycleStage = 'onboarding' | 'activation' | 'engagement' | 'expansion';
export type CampaignStatus = 'active' | 'paused';
export type TriggerOp = '>=' | '<=' | '>' | '<' | '==';

export interface TriggerRule {
    field: string;
    op: TriggerOp;
    value: number;
    and?: TriggerRule;
}

export interface CampaignOffer {
    discountPct?: number;
    couponCode?: string;
    endsAt?: number;
    bundleModules?: string[];
}

export interface CampaignVariant {
    id: string;
    headline: string;
    body: string;
    ctaLabel: string;
    weight?: number;
}

export interface CampaignSchedule {
    startAt?: number;
    endAt?: number;
}

/** The serialisable campaign shape the client consumes (CampaignDTO in upsell.ts). */
export interface CampaignDTO {
    id: string;
    module: string;
    surface: UpsellSurface;
    stage: LifecycleStage;
    priority: number;
    cooldownDays: number;
    triggerRule?: TriggerRule;
    headline: string;
    body: string;
    ctaLabel: string;
    status?: CampaignStatus;
    schedule?: CampaignSchedule;
    offer?: CampaignOffer;
    variants?: CampaignVariant[];
}

/** DB row including back-office fields the engine doesn't need. */
export interface StoredCampaign extends CampaignDTO {
    /** Published? Unpublished (draft) rows are hidden from the engine read. */
    active: boolean;
    sortOrder: number;
}

const SURFACES: readonly UpsellSurface[] = ['paywall', 'discover_card', 'daily_summary', 'inline_card', 'push'];
const STAGES: readonly LifecycleStage[] = ['onboarding', 'activation', 'engagement', 'expansion'];

// --- Schema ------------------------------------------------------------------

let ready = false;

export const ensureUpsellCampaignsTable = async (): Promise<void> => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS upsell_campaigns (
            id TEXT PRIMARY KEY,
            module TEXT NOT NULL,
            surface TEXT NOT NULL,
            stage TEXT NOT NULL DEFAULT 'activation',
            priority INT NOT NULL DEFAULT 0,
            cooldown_days INT NOT NULL DEFAULT 14,
            trigger_rule JSONB,
            headline TEXT NOT NULL DEFAULT '',
            body TEXT NOT NULL DEFAULT '',
            cta_label TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'active',
            schedule JSONB,
            offer JSONB,
            variants JSONB,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            sort_order INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_upsell_campaigns_active ON upsell_campaigns(active);`);
    ready = true;
};

export const upsellCampaignsReady = () => ready;

// --- Row mapping -------------------------------------------------------------

const toStored = (r: any): StoredCampaign => ({
    id: r.id,
    module: r.module,
    surface: r.surface,
    stage: r.stage,
    priority: typeof r.priority === 'number' ? r.priority : parseInt(r.priority ?? '0', 10),
    cooldownDays: typeof r.cooldown_days === 'number' ? r.cooldown_days : parseInt(r.cooldown_days ?? '0', 10),
    triggerRule: r.trigger_rule ?? undefined,
    headline: r.headline ?? '',
    body: r.body ?? '',
    ctaLabel: r.cta_label ?? '',
    status: r.status === 'paused' ? 'paused' : 'active',
    schedule: r.schedule ?? undefined,
    offer: r.offer ?? undefined,
    variants: Array.isArray(r.variants) ? r.variants : undefined,
    active: r.active !== false,
    sortOrder: r.sort_order ?? 0,
});

/** Strip back-office fields → the shape the client engine consumes. */
const toDTO = (s: StoredCampaign): CampaignDTO => {
    const { active, sortOrder, ...dto } = s;
    return dto;
};

// --- Cache -------------------------------------------------------------------

let cache: StoredCampaign[] | null = null;
const invalidate = () => { cache = null; };

const loadAll = async (): Promise<StoredCampaign[]> => {
    if (cache) return cache;
    try {
        const res = await db.query('SELECT * FROM upsell_campaigns ORDER BY sort_order, id');
        cache = res.rows.map(toStored);
    } catch (e: any) {
        console.warn('[upsell-campaigns] read failed, treating as empty:', e.message);
        return [];
    }
    return cache;
};

// --- Reads -------------------------------------------------------------------

/** Published campaign DTOs for the client engine (active rows only). */
export const getPublishedCampaigns = async (): Promise<CampaignDTO[]> =>
    (await loadAll()).filter(c => c.active).map(toDTO);

/** Every campaign (incl. drafts) for the Super Admin console. */
export const getAllCampaigns = async (): Promise<StoredCampaign[]> => loadAll();

export const getCampaign = async (id: string): Promise<StoredCampaign | undefined> =>
    (await loadAll()).find(c => c.id === id);

// --- Live offer discounts (server-authoritative) -----------------------------

/** A campaign's discount % right now, honouring publish/pause/schedule/expiry. */
const offerDiscountPct = (c: StoredCampaign, now: number): number => {
    if (!c.active || c.status === 'paused') return 0;
    const o = c.offer;
    if (!o || !o.discountPct || o.discountPct <= 0) return 0;
    if (o.endsAt != null && now > o.endsAt) return 0;
    const s = c.schedule;
    if (s) {
        if (s.startAt != null && now < s.startAt) return 0;
        if (s.endAt != null && now > s.endAt) return 0;
    }
    return Math.max(0, Math.min(100, o.discountPct));
};

/**
 * Highest live offer discount (%) per module right now. The purchase path applies
 * this server-side so an intro offer genuinely reduces the charge — the client
 * never dictates price; it only displays the same maths from the same campaign.
 */
export const getModuleDiscounts = async (): Promise<Record<string, number>> => {
    const now = Date.now();
    const map: Record<string, number> = {};
    for (const c of await loadAll()) {
        const pct = offerDiscountPct(c, now);
        if (pct > 0) map[c.module] = Math.max(map[c.module] || 0, pct);
    }
    return map;
};

// --- Writes ------------------------------------------------------------------

const slugify = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `camp_${Date.now()}`;

const json = (v: any): string | null => (v == null ? null : JSON.stringify(v));

const writeCampaign = async (c: StoredCampaign): Promise<void> => {
    await db.query(
        `INSERT INTO upsell_campaigns
            (id, module, surface, stage, priority, cooldown_days, trigger_rule, headline, body, cta_label, status, schedule, offer, variants, active, sort_order, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16, NOW())
         ON CONFLICT (id) DO UPDATE SET
            module = EXCLUDED.module, surface = EXCLUDED.surface, stage = EXCLUDED.stage,
            priority = EXCLUDED.priority, cooldown_days = EXCLUDED.cooldown_days,
            trigger_rule = EXCLUDED.trigger_rule, headline = EXCLUDED.headline, body = EXCLUDED.body,
            cta_label = EXCLUDED.cta_label, status = EXCLUDED.status, schedule = EXCLUDED.schedule,
            offer = EXCLUDED.offer, variants = EXCLUDED.variants, active = EXCLUDED.active,
            sort_order = EXCLUDED.sort_order, updated_at = NOW()`,
        [
            c.id, c.module, c.surface, c.stage, c.priority, c.cooldownDays,
            json(c.triggerRule), c.headline, c.body, c.ctaLabel, c.status ?? 'active',
            json(c.schedule), json(c.offer), json(c.variants), c.active, c.sortOrder,
        ],
    );
};

const normSurface = (v: any, fallback: UpsellSurface): UpsellSurface =>
    SURFACES.includes(v) ? v : fallback;
const normStage = (v: any, fallback: LifecycleStage): LifecycleStage =>
    STAGES.includes(v) ? v : fallback;

/** Create or update a campaign. `id` absent → derived from headline/module. */
export const upsertCampaign = async (input: Partial<StoredCampaign>): Promise<StoredCampaign> => {
    const existing = input.id ? await getCampaign(input.id) : undefined;
    const campaign: StoredCampaign = {
        id: input.id || slugify(input.headline || input.module || 'campaign'),
        module: input.module ?? existing?.module ?? '',
        surface: normSurface(input.surface, existing?.surface ?? 'inline_card'),
        stage: normStage(input.stage, existing?.stage ?? 'activation'),
        priority: input.priority ?? existing?.priority ?? 0,
        cooldownDays: input.cooldownDays ?? existing?.cooldownDays ?? 14,
        triggerRule: input.triggerRule !== undefined ? input.triggerRule : existing?.triggerRule,
        headline: input.headline ?? existing?.headline ?? '',
        body: input.body ?? existing?.body ?? '',
        ctaLabel: input.ctaLabel ?? existing?.ctaLabel ?? '',
        status: input.status ?? existing?.status ?? 'active',
        schedule: input.schedule !== undefined ? input.schedule : existing?.schedule,
        offer: input.offer !== undefined ? input.offer : existing?.offer,
        variants: input.variants !== undefined ? input.variants : existing?.variants,
        active: input.active ?? existing?.active ?? true,
        sortOrder: input.sortOrder ?? existing?.sortOrder ?? 0,
    };
    await writeCampaign(campaign);
    invalidate();
    return campaign;
};

export const deleteCampaign = async (id: string): Promise<void> => {
    await db.query('DELETE FROM upsell_campaigns WHERE id = $1', [id]);
    invalidate();
};
