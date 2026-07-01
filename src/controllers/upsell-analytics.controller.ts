import express from 'express';
import { recordEvent, getFunnel, toEventType } from '../services/upsell-analytics.service';

/**
 * Upsell analytics endpoints: a lightweight event recorder the client calls on
 * impression / click / convert / dismiss, and a super-admin funnel report.
 */

const num = (v: any): number | undefined => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
};
const str = (v: any): string | undefined => (v == null ? undefined : String(v));

/** Record a single upsell funnel event (any authenticated merchant). */
export const recordUpsellEvent = async (req: express.Request, res: express.Response) => {
    try {
        const b = req.body || {};
        const event = toEventType(b.name || b.event);
        if (!event || !b.momentId) {
            return res.status(400).json({ message: 'event name and momentId are required.' });
        }
        await recordEvent({
            event,
            momentId: String(b.momentId),
            module: str(b.module),
            surface: str(b.surface),
            variantId: str(b.variantId),
            storeId: req.user?.currentStoreId,
            value: num(b.value),
        });
        return res.status(202).json({ ok: true });
    } catch (e: any) {
        // Telemetry must never surface an error to the client UI.
        return res.status(202).json({ ok: false });
    }
};

/** Super-admin marketing funnel (per campaign + variant) over a window. */
export const getUpsellAnalytics = async (req: express.Request, res: express.Response) => {
    try {
        const days = num(req.query.days) ?? 30;
        return res.status(200).json(await getFunnel(days));
    } catch (e: any) {
        console.error('Error loading upsell analytics', e);
        return res.status(500).json({ message: 'Failed to load analytics.' });
    }
};
