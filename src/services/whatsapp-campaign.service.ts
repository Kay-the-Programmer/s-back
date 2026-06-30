import db from '../db_client';
import whatsAppService from './whatsapp.service';
import { MODULES, isModuleEnabled } from './entitlements.service';
import { generateId } from '../utils/helpers';

/** Dev free-override (mirrors whatsapp.controller). */
const WHATSAPP_FREE = process.env.WHATSAPP_FREE !== 'false';
/** Safety cap: max recipients messaged per campaign per scheduler tick. */
const MAX_PER_RUN = 250;
/** How often a trigger campaign re-evaluates (avoids hammering every tick). */
const TRIGGER_MIN_GAP_MS = 50 * 60 * 1000;

export type CampaignType = 'one_off' | 'recurring' | 'trigger';

interface AudienceRow { id: string; name: string; phone: string; }

interface CampaignRow {
    id: string; store_id: string; name: string; type: CampaignType; status: string;
    segment: string; segment_params: any;
    message_mode: 'text' | 'template'; message_text: string | null;
    template_name: string | null; template_lang: string | null; template_params: any;
    scheduled_at: string | null; recurrence: string | null;
    trigger_event: string | null; trigger_params: any;
    last_run_at: string | null; next_run_at: string | null; sent_count: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const personalize = (text: string, c: AudienceRow, storeName: string): string => {
    const first = (c.name || '').trim().split(/\s+/)[0] || c.name || '';
    return (text || '').replace(/\[Name\]/g, first).replace(/\[Store\]/g, storeName || 'our shop');
};

const getStoreName = async (storeId: string): Promise<string> => {
    try {
        const r = await db.query('SELECT name FROM stores WHERE id = $1', [storeId]);
        return r.rows[0]?.name || 'our shop';
    } catch { return 'our shop'; }
};

/** Store can actually send right now: connected, enabled and entitled. */
const isStoreSendable = async (storeId: string): Promise<boolean> => {
    const config = await whatsAppService.getStoreConfig(storeId);
    if (!config || !config.is_enabled || !config.access_token || !config.phone_number_id) return false;
    return WHATSAPP_FREE || isModuleEnabled(storeId, MODULES.WHATSAPP_MESSAGING);
};

const num = (v: any, d: number): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const computeNextRun = (recurrence: string | null, from: Date): Date => {
    const d = new Date(from);
    if (recurrence === 'weekly') d.setDate(d.getDate() + 7);
    else if (recurrence === 'monthly') d.setMonth(d.getMonth() + 1);
    else d.setDate(d.getDate() + 1); // daily default
    return d;
};

const PHONE_FILTER = `c.phone IS NOT NULL AND c.phone <> ''`;

// ── Audience resolution ───────────────────────────────────────────────────────

/** Segment-based audience for one-off / recurring campaigns. */
const resolveSegment = async (storeId: string, segment: string, params: any): Promise<AudienceRow[]> => {
    const p = params || {};
    if (segment === 'inactive') {
        const days = num(p.days, 30);
        const r = await db.query(
            `SELECT q.id, q.name, q.phone FROM (
                SELECT c.id, c.name, c.phone, MAX(s."timestamp") AS last_sale
                FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
                WHERE c.store_id = $1 AND ${PHONE_FILTER}
                GROUP BY c.id
             ) q
             WHERE q.last_sale IS NULL OR q.last_sale < NOW() - ($2::int * INTERVAL '1 day')`,
            [storeId, days],
        );
        return r.rows;
    }
    if (segment === 'new') {
        const days = num(p.days, 14);
        const r = await db.query(
            `SELECT c.id, c.name, c.phone FROM customers c
             WHERE c.store_id = $1 AND ${PHONE_FILTER} AND c.created_at >= NOW() - ($2::int * INTERVAL '1 day')`,
            [storeId, days],
        );
        return r.rows;
    }
    if (segment === 'vip') {
        const minSpend = num(p.minSpend, 1000);
        const r = await db.query(
            `SELECT q.id, q.name, q.phone FROM (
                SELECT c.id, c.name, c.phone, COALESCE(SUM(s.total), 0) AS spend
                FROM customers c LEFT JOIN sales s ON s.customer_id = c.id
                WHERE c.store_id = $1 AND ${PHONE_FILTER}
                GROUP BY c.id
             ) q WHERE q.spend >= $2`,
            [storeId, minSpend],
        );
        return r.rows;
    }
    // 'all' / 'with_phone'
    const r = await db.query(
        `SELECT c.id, c.name, c.phone FROM customers c WHERE c.store_id = $1 AND ${PHONE_FILTER}`,
        [storeId],
    );
    return r.rows;
};

/** Event-based audience for trigger campaigns, with per-customer de-duplication. */
const resolveTrigger = async (c: CampaignRow): Promise<AudienceRow[]> => {
    const p = c.trigger_params || {};
    const storeId = c.store_id;
    if (c.trigger_event === 'welcome') {
        const days = num(p.days, 7);
        const r = await db.query(
            `SELECT c.id, c.name, c.phone FROM customers c
             WHERE c.store_id = $1 AND ${PHONE_FILTER} AND c.created_at >= NOW() - ($2::int * INTERVAL '1 day')
             AND NOT EXISTS (SELECT 1 FROM whatsapp_campaign_sends w WHERE w.campaign_id = $3 AND w.customer_id = c.id AND w.status = 'sent')`,
            [storeId, days, c.id],
        );
        return r.rows;
    }
    if (c.trigger_event === 'winback') {
        const days = num(p.days, 30);
        const r = await db.query(
            `SELECT q.id, q.name, q.phone FROM (
                SELECT c.id, c.name, c.phone, MAX(s."timestamp") AS last_sale
                FROM customers c JOIN sales s ON s.customer_id = c.id
                WHERE c.store_id = $1 AND ${PHONE_FILTER}
                GROUP BY c.id
             ) q
             WHERE q.last_sale < NOW() - ($2::int * INTERVAL '1 day')
             AND NOT EXISTS (SELECT 1 FROM whatsapp_campaign_sends w WHERE w.campaign_id = $3 AND w.customer_id = q.id AND w.sent_at > NOW() - ($2::int * INTERVAL '1 day'))`,
            [storeId, days, c.id],
        );
        return r.rows;
    }
    if (c.trigger_event === 'post_purchase') {
        const days = num(p.days, 2);
        const r = await db.query(
            `SELECT q.id, q.name, q.phone FROM (
                SELECT c.id, c.name, c.phone, MAX(s."timestamp") AS last_sale
                FROM customers c JOIN sales s ON s.customer_id = c.id
                WHERE c.store_id = $1 AND ${PHONE_FILTER}
                GROUP BY c.id
             ) q
             WHERE q.last_sale >= NOW() - ($2::int * INTERVAL '1 day')
             AND NOT EXISTS (SELECT 1 FROM whatsapp_campaign_sends w WHERE w.campaign_id = $3 AND w.customer_id = q.id AND w.sent_at > q.last_sale)`,
            [storeId, days, c.id],
        );
        return r.rows;
    }
    return [];
};

const resolveAudience = (c: CampaignRow): Promise<AudienceRow[]> =>
    c.type === 'trigger' ? resolveTrigger(c) : resolveSegment(c.store_id, c.segment, c.segment_params);

// ── Sending ───────────────────────────────────────────────────────────────────

const recordSend = (campaignId: string, storeId: string, customerId: string | null, phone: string, status: string, error: string | null) =>
    db.query(
        `INSERT INTO whatsapp_campaign_sends (id, campaign_id, store_id, customer_id, phone, status, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [generateId('wac'), campaignId, storeId, customerId, phone, status, error],
    ).catch(e => console.warn('[wa-campaign] failed to record send:', e.message));

const sendToCustomer = async (c: CampaignRow, cust: AudienceRow, storeName: string): Promise<boolean> => {
    try {
        let apiResp: any; let content: string; let type: 'text' | 'template';
        if (c.message_mode === 'template' && c.template_name) {
            const params = (Array.isArray(c.template_params) ? c.template_params : []).map((x: string) => personalize(String(x), cust, storeName));
            apiResp = await whatsAppService.sendTemplateMessage(c.store_id, cust.phone, c.template_name, c.template_lang || 'en_US', params);
            content = `[template: ${c.template_name}]`;
            type = 'template';
        } else {
            content = personalize(c.message_text || '', cust, storeName);
            apiResp = await whatsAppService.sendTextMessage(c.store_id, cust.phone, content);
            type = 'text';
        }
        const wamid = apiResp?.messages?.[0]?.id;
        const convId = await whatsAppService.getOrCreateConversation(c.store_id, cust.phone, cust.name);
        await whatsAppService.logMessage(convId, c.store_id, 'outbound', type, content, wamid, 'sent', false);
        await recordSend(c.id, c.store_id, cust.id, cust.phone, 'sent', null);
        return true;
    } catch (e: any) {
        await recordSend(c.id, c.store_id, cust.id, cust.phone, 'failed', (e?.message || 'error').slice(0, 300));
        return false;
    }
};

/** Send a campaign to its current audience now. Returns counts. */
const runCampaign = async (c: CampaignRow): Promise<{ sent: number; failed: number }> => {
    const storeName = await getStoreName(c.store_id);
    const audience = (await resolveAudience(c)).slice(0, MAX_PER_RUN);
    let sent = 0, failed = 0;
    for (const cust of audience) {
        if (await sendToCustomer(c, cust, storeName)) sent++; else failed++;
    }
    return { sent, failed };
};

// ── Scheduler entry point (called from index.ts on an interval) ───────────────

export const runDueCampaigns = async (): Promise<number> => {
    const now = Date.now();
    let processed = 0;
    let rows: CampaignRow[] = [];
    try {
        rows = (await db.query(`SELECT * FROM whatsapp_campaigns WHERE status IN ('scheduled','active')`)).rows;
    } catch (e: any) {
        // Table may not exist on an un-migrated deployment — skip quietly.
        console.warn('[wa-campaign] scheduler skipped:', e.message);
        return 0;
    }

    for (const c of rows) {
        try {
            let due = false;
            if (c.type === 'one_off' && c.status === 'scheduled') {
                due = !!c.scheduled_at && new Date(c.scheduled_at).getTime() <= now;
            } else if (c.type === 'recurring' && c.status === 'active') {
                due = !c.next_run_at || new Date(c.next_run_at).getTime() <= now;
            } else if (c.type === 'trigger' && c.status === 'active') {
                due = !c.last_run_at || (now - new Date(c.last_run_at).getTime()) > TRIGGER_MIN_GAP_MS;
            }
            if (!due) continue;
            if (!(await isStoreSendable(c.store_id))) continue; // not connected/entitled — leave for later

            const { sent } = await runCampaign(c);

            if (c.type === 'one_off') {
                await db.query(`UPDATE whatsapp_campaigns SET status='completed', last_run_at=NOW(), sent_count=sent_count+$2, updated_at=NOW() WHERE id=$1`, [c.id, sent]);
            } else if (c.type === 'recurring') {
                await db.query(`UPDATE whatsapp_campaigns SET last_run_at=NOW(), next_run_at=$2, sent_count=sent_count+$3, updated_at=NOW() WHERE id=$1`, [c.id, computeNextRun(c.recurrence, new Date()), sent]);
            } else {
                await db.query(`UPDATE whatsapp_campaigns SET last_run_at=NOW(), sent_count=sent_count+$2, updated_at=NOW() WHERE id=$1`, [c.id, sent]);
            }
            processed++;
        } catch (err: any) {
            console.error(`[wa-campaign] run error for ${c.id}:`, err.message);
        }
    }
    if (processed > 0) console.log(`[wa-campaign] processed ${processed} campaign(s).`);
    return processed;
};

// ── CRUD (used by the controller) ─────────────────────────────────────────────

export const listCampaigns = async (storeId: string): Promise<any[]> => {
    const r = await db.query('SELECT * FROM whatsapp_campaigns WHERE store_id = $1 ORDER BY created_at DESC', [storeId]);
    return r.rows;
};

export const createCampaign = async (storeId: string, userId: string | undefined, body: any): Promise<any> => {
    const type: CampaignType = ['one_off', 'recurring', 'trigger'].includes(body.type) ? body.type : 'one_off';
    const id = generateId('wacmp');

    // Initial status + scheduling per type.
    let status = 'scheduled';
    let scheduledAt: Date | null = body.scheduledAt ? new Date(body.scheduledAt) : null;
    let nextRun: Date | null = null;
    if (type === 'one_off') { status = 'scheduled'; if (!scheduledAt) scheduledAt = new Date(); }
    else if (type === 'recurring') { status = 'active'; nextRun = scheduledAt || new Date(); }
    else { status = 'active'; } // trigger

    const r = await db.query(
        `INSERT INTO whatsapp_campaigns
          (id, store_id, name, type, status, segment, segment_params, message_mode, message_text,
           template_name, template_lang, template_params, scheduled_at, recurrence, trigger_event, trigger_params,
           next_run_at, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW(),NOW())
         RETURNING *`,
        [
            id, storeId, (body.name || 'Untitled campaign').slice(0, 120), type, status,
            body.segment || 'all', body.segmentParams ? JSON.stringify(body.segmentParams) : null,
            body.messageMode === 'template' ? 'template' : 'text', body.messageText || null,
            body.templateName || null, body.templateLang || 'en_US', body.templateParams ? JSON.stringify(body.templateParams) : null,
            scheduledAt, body.recurrence || null, body.triggerEvent || null, body.triggerParams ? JSON.stringify(body.triggerParams) : null,
            nextRun, userId || null,
        ],
    );
    return r.rows[0];
};

export const updateCampaignStatus = async (storeId: string, id: string, status: string): Promise<any | null> => {
    const allowed = ['active', 'paused', 'scheduled', 'cancelled'];
    if (!allowed.includes(status)) return null;
    const r = await db.query(
        'UPDATE whatsapp_campaigns SET status=$3, updated_at=NOW() WHERE id=$1 AND store_id=$2 RETURNING *',
        [id, storeId, status],
    );
    return r.rows[0] || null;
};

export const deleteCampaign = async (storeId: string, id: string): Promise<boolean> => {
    const r = await db.query('DELETE FROM whatsapp_campaigns WHERE id=$1 AND store_id=$2', [id, storeId]);
    return (r.rowCount || 0) > 0;
};

/** Send a campaign immediately (the "Run now" / "Send now" action). */
export const runCampaignNow = async (storeId: string, id: string): Promise<{ sent: number; failed: number }> => {
    const r = await db.query('SELECT * FROM whatsapp_campaigns WHERE id=$1 AND store_id=$2', [id, storeId]);
    const c: CampaignRow = r.rows[0];
    if (!c) throw new Error('Campaign not found.');
    if (!(await isStoreSendable(storeId))) throw new Error('WhatsApp isn\'t connected/enabled for this store.');
    const result = await runCampaign(c);
    const completeOneOff = c.type === 'one_off' ? `, status='completed'` : '';
    await db.query(`UPDATE whatsapp_campaigns SET last_run_at=NOW(), sent_count=sent_count+$2, updated_at=NOW()${completeOneOff} WHERE id=$1`, [id, result.sent]);
    return result;
};
