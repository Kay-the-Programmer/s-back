import db from '../db_client';

/**
 * Upsell campaign analytics — server-side capture of the marketing funnel so the
 * Super Admin can see which campaigns (and which A/B variants) actually convert.
 * The client records impression / click / convert / dismiss events here (in
 * addition to GA4), keyed by campaign id + variant.
 */

export type UpsellEvent = 'impression' | 'click' | 'convert' | 'dismiss';
const EVENTS: readonly UpsellEvent[] = ['impression', 'click', 'convert', 'dismiss'];

let ready = false;

export const ensureUpsellEventsTable = async (): Promise<void> => {
    await db.query(`
        CREATE TABLE IF NOT EXISTS upsell_events (
            id BIGSERIAL PRIMARY KEY,
            event TEXT NOT NULL,
            moment_id TEXT NOT NULL,
            module TEXT,
            surface TEXT,
            variant_id TEXT,
            store_id TEXT,
            value NUMERIC(10,2) NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_upsell_events_moment ON upsell_events(moment_id, event);`);
    await db.query(`CREATE INDEX IF NOT EXISTS idx_upsell_events_created ON upsell_events(created_at);`);
    ready = true;
};
export const upsellEventsReady = () => ready;

/** Normalise the client event name ('upsell_click') to a stored type ('click'). */
export const toEventType = (name: string): UpsellEvent | null => {
    const t = String(name || '').replace(/^upsell_/, '') as UpsellEvent;
    return EVENTS.includes(t) ? t : null;
};

export interface RecordEventInput {
    event: UpsellEvent;
    momentId: string;
    module?: string;
    surface?: string;
    variantId?: string;
    storeId?: string;
    value?: number;
}

export const recordEvent = async (e: RecordEventInput): Promise<void> => {
    await db.query(
        `INSERT INTO upsell_events (event, moment_id, module, surface, variant_id, store_id, value)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [e.event, e.momentId, e.module ?? null, e.surface ?? null, e.variantId ?? null, e.storeId ?? null,
         Number.isFinite(e.value as number) ? e.value : 0],
    );
};

// --- Funnel aggregation ------------------------------------------------------

export interface FunnelRow {
    impressions: number;
    clicks: number;
    conversions: number;
    revenue: number;
}
export interface VariantFunnel extends FunnelRow { variantId: string }
export interface CampaignFunnel extends FunnelRow {
    momentId: string;
    module: string | null;
    surface: string | null;
    variants: VariantFunnel[];
}
export interface FunnelReport {
    totals: FunnelRow;
    campaigns: CampaignFunnel[];
    sinceDays: number;
}

const zero = (): FunnelRow => ({ impressions: 0, clicks: 0, conversions: 0, revenue: 0 });
const add = (acc: FunnelRow, r: any) => {
    acc.impressions += Number(r.impressions) || 0;
    acc.clicks += Number(r.clicks) || 0;
    acc.conversions += Number(r.conversions) || 0;
    acc.revenue += Number(r.revenue) || 0;
};

/** Funnel grouped by campaign (with per-variant rows nested) over a window. */
export const getFunnel = async (sinceDays = 30): Promise<FunnelReport> => {
    const days = Number.isFinite(sinceDays) && sinceDays > 0 ? Math.min(365, Math.trunc(sinceDays)) : 30;
    let rows: any[] = [];
    try {
        const res = await db.query(
            `SELECT moment_id, module, surface, COALESCE(variant_id, '') AS variant_id,
                COUNT(*) FILTER (WHERE event='impression') AS impressions,
                COUNT(*) FILTER (WHERE event='click')      AS clicks,
                COUNT(*) FILTER (WHERE event='convert')    AS conversions,
                COALESCE(SUM(value) FILTER (WHERE event='convert'), 0) AS revenue
             FROM upsell_events
             WHERE created_at >= NOW() - ($1 || ' days')::interval
             GROUP BY moment_id, module, surface, COALESCE(variant_id, '')
             ORDER BY impressions DESC`,
            [String(days)],
        );
        rows = res.rows;
    } catch (e: any) {
        console.warn('[upsell-analytics] funnel query failed:', e.message);
    }

    const totals = zero();
    const byCampaign = new Map<string, CampaignFunnel>();
    for (const r of rows) {
        add(totals, r);
        let c = byCampaign.get(r.moment_id);
        if (!c) {
            c = { momentId: r.moment_id, module: r.module, surface: r.surface, variants: [], ...zero() };
            byCampaign.set(r.moment_id, c);
        }
        add(c, r);
        if (r.variant_id) {
            c.variants.push({ variantId: r.variant_id, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, conversions: Number(r.conversions) || 0, revenue: Number(r.revenue) || 0 });
        }
    }
    const campaigns = [...byCampaign.values()].sort((a, b) => b.impressions - a.impressions);
    return { totals, campaigns, sinceDays: days };
};
