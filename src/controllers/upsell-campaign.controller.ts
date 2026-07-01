import express from 'express';
import { auditService } from '../services/audit.service';
import {
    getAllCampaigns, getPublishedCampaigns, upsertCampaign, deleteCampaign,
    StoredCampaign, TriggerRule, CampaignOffer, CampaignVariant, CampaignSchedule,
} from '../services/upsell-campaign.service';

/**
 * Super Admin upsell-campaign management. The marketing console authors the
 * campaigns that drive add-on revenue; the public read feeds the client engine,
 * which merges them over its built-in defaults.
 */

const num = (v: any, fallback = 0) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
};
const str = (v: any) => (v == null ? '' : String(v));

const OPS = ['>=', '<=', '>', '<', '=='];

/** Defensively parse a (possibly nested) trigger rule from untrusted input. */
function parseRule(v: any, depth = 0): TriggerRule | undefined {
    if (!v || typeof v !== 'object' || depth > 4) return undefined;
    if (typeof v.field !== 'string' || !OPS.includes(v.op)) return undefined;
    const rule: TriggerRule = { field: v.field, op: v.op, value: num(v.value) };
    const and = parseRule(v.and, depth + 1);
    if (and) rule.and = and;
    return rule;
}

function parseOffer(v: any): CampaignOffer | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const offer: CampaignOffer = {};
    if (v.discountPct != null) offer.discountPct = Math.max(0, Math.min(100, num(v.discountPct)));
    if (v.couponCode) offer.couponCode = str(v.couponCode).trim();
    if (v.endsAt != null) offer.endsAt = num(v.endsAt);
    if (Array.isArray(v.bundleModules)) offer.bundleModules = v.bundleModules.filter((x: any) => typeof x === 'string');
    return Object.keys(offer).length ? offer : undefined;
}

function parseSchedule(v: any): CampaignSchedule | undefined {
    if (!v || typeof v !== 'object') return undefined;
    const s: CampaignSchedule = {};
    if (v.startAt != null) s.startAt = num(v.startAt);
    if (v.endAt != null) s.endAt = num(v.endAt);
    return Object.keys(s).length ? s : undefined;
}

function parseVariants(v: any): CampaignVariant[] | undefined {
    if (!Array.isArray(v) || v.length === 0) return undefined;
    const variants = v
        .filter(x => x && typeof x === 'object' && x.id)
        .map((x: any): CampaignVariant => ({
            id: str(x.id).trim(),
            headline: str(x.headline),
            body: str(x.body),
            ctaLabel: str(x.ctaLabel),
            ...(x.weight != null ? { weight: Math.max(0, num(x.weight, 1)) } : {}),
        }));
    return variants.length ? variants : undefined;
}

export const listCampaigns = async (_req: express.Request, res: express.Response) => {
    try {
        return res.status(200).json({ campaigns: await getAllCampaigns() });
    } catch (e: any) {
        console.error('Error listing upsell campaigns', e);
        return res.status(500).json({ message: 'Failed to load campaigns.' });
    }
};

export const saveCampaign = async (req: express.Request, res: express.Response) => {
    try {
        const b = req.body || {};
        if (!b.module || !str(b.module).trim()) {
            return res.status(400).json({ message: 'A target module is required.' });
        }
        if (!b.surface) {
            return res.status(400).json({ message: 'A surface is required.' });
        }
        const input: Partial<StoredCampaign> = {
            id: req.params.id || b.id,
            module: str(b.module).trim(),
            surface: b.surface,
            stage: b.stage,
            priority: b.priority != null ? Math.trunc(num(b.priority)) : undefined,
            cooldownDays: b.cooldownDays != null ? Math.trunc(num(b.cooldownDays)) : undefined,
            triggerRule: 'triggerRule' in b ? parseRule(b.triggerRule) : undefined,
            headline: b.headline != null ? str(b.headline) : undefined,
            body: b.body != null ? str(b.body) : undefined,
            ctaLabel: b.ctaLabel != null ? str(b.ctaLabel) : undefined,
            status: b.status === 'paused' ? 'paused' : (b.status === 'active' ? 'active' : undefined),
            schedule: 'schedule' in b ? parseSchedule(b.schedule) : undefined,
            offer: 'offer' in b ? parseOffer(b.offer) : undefined,
            variants: 'variants' in b ? parseVariants(b.variants) : undefined,
            active: b.active != null ? !!b.active : undefined,
            sortOrder: b.sortOrder != null ? Math.trunc(num(b.sortOrder)) : undefined,
        };
        const saved = await upsertCampaign(input);
        await auditService.log(req.user!, 'Upsell Campaign Saved', `${saved.id} → ${saved.module} (${saved.surface})`);
        return res.status(200).json({ campaign: saved });
    } catch (e: any) {
        console.error('Error saving upsell campaign', e);
        return res.status(500).json({ message: 'Failed to save campaign.' });
    }
};

export const removeCampaign = async (req: express.Request, res: express.Response) => {
    try {
        await deleteCampaign(req.params.id);
        await auditService.log(req.user!, 'Upsell Campaign Deleted', req.params.id);
        return res.status(200).json({ ok: true });
    } catch (e: any) {
        console.error('Error deleting upsell campaign', e);
        return res.status(500).json({ message: 'Failed to delete campaign.' });
    }
};

/** Public read for the client engine — published campaigns only. */
export const getPublicCampaigns = async (_req: express.Request, res: express.Response) => {
    try {
        return res.status(200).json({ campaigns: await getPublishedCampaigns() });
    } catch (e: any) {
        console.error('Error loading public upsell campaigns', e);
        // Never break the engine — it has its own built-in fallback.
        return res.status(200).json({ campaigns: [] });
    }
};
