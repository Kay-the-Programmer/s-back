import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { sendEmail } from '../services/email.service';

/**
 * CRM store-facing endpoints: the loyalty program, its redemption ledger,
 * reusable message templates and customer email outreach.
 *
 * All of this previously lived in the browser's localStorage, which meant the
 * loyalty program and the templates differed per device and redemption history
 * was lost with the browser profile. Everything here is scoped by store_id.
 */

const storeOf = (req: express.Request): string | undefined =>
    (req as any).tenant?.storeId || req.user?.currentStoreId;

const requireStore = (req: express.Request, res: express.Response): string | null => {
    const storeId = storeOf(req);
    if (!storeId) {
        res.status(400).json({ message: 'No shop is selected. Pick one from My Shops and try again.' });
        return null;
    }
    return storeId;
};

/* ───────────────────────────── Loyalty program ───────────────────────────── */

const DEFAULT_PROGRAM = {
    enabled: true,
    earnSpendPerPoint: 10,
    redeemPointsPerUnit: 100,
    redeemValuePerUnit: 5,
    minRedeemPoints: 0,
    expiryEnabled: false,
    expiryMonths: 12,
};

/** Shape a DB row as the client's LoyaltyConfig (numbers, not pg DECIMAL strings). */
const rowToProgram = (row: any) => ({
    enabled: !!row.enabled,
    earnSpendPerPoint: Number(row.earn_spend_per_point),
    redeemPointsPerUnit: Number(row.redeem_points_per_unit),
    redeemValuePerUnit: Number(row.redeem_value_per_unit),
    minRedeemPoints: Number(row.min_redeem_points),
    expiryEnabled: !!row.expiry_enabled,
    expiryMonths: Number(row.expiry_months),
});

export const getLoyaltyProgram = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    try {
        const result = await db.query('SELECT * FROM loyalty_programs WHERE store_id = $1', [storeId]);
        // A store that has never configured the program gets the defaults — the
        // CRM shows an active program out of the box, as it always has.
        res.status(200).json(result.rowCount ? rowToProgram(result.rows[0]) : { ...DEFAULT_PROGRAM });
    } catch (error) {
        console.error('[crm] Error fetching loyalty program:', error);
        res.status(500).json({ message: 'Error fetching loyalty program' });
    }
};

/** Clamp an incoming config value, falling back to the stored/default one. */
const posInt = (v: unknown, fallback: number, min = 0): number => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
};
const posNum = (v: unknown, fallback: number, min = 0): number => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, n) : fallback;
};

export const saveLoyaltyProgram = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const b = req.body || {};
    const cfg = {
        enabled: b.enabled === undefined ? DEFAULT_PROGRAM.enabled : !!b.enabled,
        // An earn rate of 0 would divide by zero when awarding points.
        earnSpendPerPoint: posNum(b.earnSpendPerPoint, DEFAULT_PROGRAM.earnSpendPerPoint, 1),
        redeemPointsPerUnit: posInt(b.redeemPointsPerUnit, DEFAULT_PROGRAM.redeemPointsPerUnit, 1),
        redeemValuePerUnit: posNum(b.redeemValuePerUnit, DEFAULT_PROGRAM.redeemValuePerUnit, 0),
        minRedeemPoints: posInt(b.minRedeemPoints, DEFAULT_PROGRAM.minRedeemPoints, 0),
        expiryEnabled: !!b.expiryEnabled,
        expiryMonths: posInt(b.expiryMonths, DEFAULT_PROGRAM.expiryMonths, 1),
    };

    try {
        const result = await db.query(
            `INSERT INTO loyalty_programs
                (store_id, enabled, earn_spend_per_point, redeem_points_per_unit, redeem_value_per_unit,
                 min_redeem_points, expiry_enabled, expiry_months, updated_at, updated_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW(),$9)
             ON CONFLICT (store_id) DO UPDATE SET
                enabled = EXCLUDED.enabled,
                earn_spend_per_point = EXCLUDED.earn_spend_per_point,
                redeem_points_per_unit = EXCLUDED.redeem_points_per_unit,
                redeem_value_per_unit = EXCLUDED.redeem_value_per_unit,
                min_redeem_points = EXCLUDED.min_redeem_points,
                expiry_enabled = EXCLUDED.expiry_enabled,
                expiry_months = EXCLUDED.expiry_months,
                updated_at = NOW(),
                updated_by = EXCLUDED.updated_by
             RETURNING *`,
            [storeId, cfg.enabled, cfg.earnSpendPerPoint, cfg.redeemPointsPerUnit, cfg.redeemValuePerUnit,
                cfg.minRedeemPoints, cfg.expiryEnabled, cfg.expiryMonths, req.user?.id || null],
        );
        if (req.user) {
            auditService.log(req.user, 'Loyalty Program Updated',
                `${cfg.enabled ? 'Active' : 'Paused'} — 1 pt / ${cfg.earnSpendPerPoint}, ${cfg.redeemPointsPerUnit} pts = ${cfg.redeemValuePerUnit}`)
                .catch(() => { /* audit is best-effort */ });
        }
        res.status(200).json(rowToProgram(result.rows[0]));
    } catch (error) {
        console.error('[crm] Error saving loyalty program:', error);
        res.status(500).json({ message: 'Error saving loyalty program' });
    }
};

/* ──────────────────────────── Redemption ledger ──────────────────────────── */

export const getRedemptions = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const { customerId } = req.query as { customerId?: string };
    try {
        const params: any[] = [storeId];
        let where = 'r.store_id = $1';
        if (customerId) { params.push(customerId); where += ` AND r.customer_id = $${params.length}`; }
        const result = await db.query(
            `SELECT r.*, c.name AS customer_name
               FROM loyalty_redemptions r
               LEFT JOIN customers c ON c.id = r.customer_id AND c.store_id = r.store_id
              WHERE ${where}
              ORDER BY r.created_at DESC
              LIMIT 500`,
            params,
        );
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('[crm] Error fetching redemptions:', error);
        res.status(500).json({ message: 'Error fetching redemptions' });
    }
};

/**
 * Points earned per customer, straight from the ledger.
 *
 * The CRM used to derive this client-side from lifetime spend, which meant the
 * browser re-priced every balance whenever the earn rate changed. One row per
 * customer who has ever earned, so the whole customer list can be rendered
 * from a single call.
 */
export const getPointsEarned = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const { customerId } = req.query as { customerId?: string };
    try {
        const params: any[] = [storeId];
        let where = 'store_id = $1';
        if (customerId) { params.push(customerId); where += ` AND customer_id = $${params.length}`; }
        const result = await db.query(
            `SELECT customer_id, COALESCE(SUM(points), 0)::int AS points
               FROM loyalty_points WHERE ${where}
              GROUP BY customer_id`,
            params,
        );
        res.status(200).json(result.rows.map((r: any) => ({
            customerId: r.customer_id,
            // A customer whose returns outweigh their purchases is at zero, not
            // in debt — the balance maths clamps the same way.
            points: Math.max(0, Number(r.points) || 0),
        })));
    } catch (error) {
        console.error('[crm] Error fetching earned points:', error);
        res.status(500).json({ message: 'Error fetching earned points' });
    }
};

/**
 * Redeem points for store credit.
 *
 * The grant and the ledger row are one transaction, so a failed credit can
 * never leave a phantom redemption (the old client-side flow could). The server
 * recomputes what the customer is owed from their own sales + the stored
 * program, so the client cannot ask for more credit than the points cover.
 */
export const createRedemption = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const { customerId } = req.body as { customerId?: string };
    if (!customerId) return res.status(400).json({ message: 'Choose a customer first.' });

    const client = await (db as any)._pool.connect();
    try {
        await client.query('BEGIN');

        const custResult = await client.query(
            'SELECT * FROM customers WHERE id = $1 AND store_id = $2 FOR UPDATE',
            [customerId, storeId],
        );
        if (custResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Customer not found' });
        }
        const customer = custResult.rows[0];

        const progResult = await client.query('SELECT * FROM loyalty_programs WHERE store_id = $1', [storeId]);
        const cfg = progResult.rowCount ? rowToProgram(progResult.rows[0]) : { ...DEFAULT_PROGRAM };
        if (!cfg.enabled) {
            await client.query('ROLLBACK');
            return res.status(409).json({ message: 'The loyalty program is currently paused.', code: 'LOYALTY_PAUSED' });
        }

        // Points earned come from the append-only ledger — each row written at
        // the rate in force when that sale happened — minus what has already
        // been redeemed. They are NOT re-derived from lifetime spend, so
        // changing the earn rate cannot re-price a balance the customer has
        // already been shown. Mirrors the client's crmModel.
        const earnedResult = await client.query(
            'SELECT COALESCE(SUM(points), 0) AS points FROM loyalty_points WHERE customer_id = $1 AND store_id = $2',
            [customerId, storeId],
        );
        const lastPurchaseResult = await client.query(
            'SELECT MAX(timestamp) AS last_purchase FROM sales WHERE customer_id = $1 AND store_id = $2',
            [customerId, storeId],
        );
        const lastPurchase = lastPurchaseResult.rows[0].last_purchase ? new Date(lastPurchaseResult.rows[0].last_purchase) : null;

        // Expiry stays an ACCOUNT-level inactivity rule ("points lapse if a
        // customer hasn't purchased in N months"), which is what the setting
        // says and what stores that switched it on already have. Lapsing
        // individual earn rows as they age would be a different, unannounced
        // promise — and the ledger keeps the dates, so it stays available.
        const expired = cfg.expiryEnabled && !!lastPurchase
            && (Date.now() - lastPurchase.getTime()) > cfg.expiryMonths * 30 * 86400000;
        const earned = expired ? 0 : Math.max(0, Number(earnedResult.rows[0].points) || 0);

        const redeemedResult = await client.query(
            'SELECT COALESCE(SUM(points), 0) AS points FROM loyalty_redemptions WHERE customer_id = $1 AND store_id = $2',
            [customerId, storeId],
        );
        const alreadyRedeemed = Number(redeemedResult.rows[0].points) || 0;
        const balance = Math.max(0, earned - alreadyRedeemed);

        const blocks = Math.floor(balance / cfg.redeemPointsPerUnit);
        if (blocks < 1 || balance < cfg.minRedeemPoints) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                message: cfg.minRedeemPoints > 0 && balance < cfg.minRedeemPoints
                    ? `Needs at least ${cfg.minRedeemPoints} points to redeem.`
                    : 'Not enough points to redeem yet.',
                code: 'INSUFFICIENT_POINTS',
                pointsBalance: balance,
            });
        }

        const points = blocks * cfg.redeemPointsPerUnit;
        const value = Number((blocks * cfg.redeemValuePerUnit).toFixed(2));

        const id = generateId('rdm');
        await client.query(
            `INSERT INTO loyalty_redemptions (id, store_id, customer_id, points, value, redeemed_by)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [id, storeId, customerId, points, value, req.user?.id || null],
        );
        const updated = await client.query(
            'UPDATE customers SET store_credit = COALESCE(store_credit, 0) + $1 WHERE id = $2 AND store_id = $3 RETURNING *',
            [value, customerId, storeId],
        );

        await client.query('COMMIT');

        if (req.user) {
            auditService.log(req.user, 'Loyalty Points Redeemed',
                `${points} pts → ${value} store credit for "${customer.name}"`)
                .catch(() => { /* audit is best-effort */ });
        }

        return res.status(201).json({
            redemption: toCamelCase({ id, store_id: storeId, customer_id: customerId, points, value, created_at: new Date().toISOString() }),
            customer: toCamelCase(updated.rows[0]),
            pointsBalance: Math.max(0, balance - points),
        });
    } catch (error) {
        await client.query('ROLLBACK').catch(() => { /* already rolled back */ });
        console.error('[crm] Error redeeming points:', error);
        return res.status(500).json({ message: 'Error redeeming points' });
    } finally {
        client.release();
    }
};

/* ──────────────────────────── Message templates ──────────────────────────── */

/** Seeded on first read so a new store starts with usable messages. */
const DEFAULT_TEMPLATES: { label: string; body: string }[] = [
    { label: 'Loyalty Reward', body: 'Hi [Name], as a valued member you have loyalty points ready to redeem. Visit us soon! — [Store]' },
    { label: 'Special Discount', body: 'Special offer for you, [Name]! Use code PILOT20 for 20% off your next purchase this weekend. — [Store]' },
    { label: 'Checking In', body: "Hi [Name], we haven't seen you in a while! Just checking in to see if there's anything we can help you find. — [Store]" },
    { label: 'Order Ready', body: 'Hi [Name], your order is ready for pickup. See you soon! — [Store]' },
    { label: 'Thank You', body: 'Thank you for your purchase, [Name]! We really appreciate your business. — [Store]' },
];

export const getMessageTemplates = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    try {
        let result = await db.query(
            'SELECT id, label, body, created_at, updated_at FROM crm_message_templates WHERE store_id = $1 ORDER BY label',
            [storeId],
        );
        if (result.rowCount === 0) {
            for (const t of DEFAULT_TEMPLATES) {
                await db.query(
                    'INSERT INTO crm_message_templates (id, store_id, label, body) VALUES ($1,$2,$3,$4)',
                    [generateId('tpl'), storeId, t.label, t.body],
                );
            }
            result = await db.query(
                'SELECT id, label, body, created_at, updated_at FROM crm_message_templates WHERE store_id = $1 ORDER BY label',
                [storeId],
            );
        }
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('[crm] Error fetching message templates:', error);
        res.status(500).json({ message: 'Error fetching message templates' });
    }
};

export const createMessageTemplate = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const label = String(req.body?.label || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!label || !body) return res.status(400).json({ message: 'A template needs a name and a message.' });
    try {
        const result = await db.query(
            'INSERT INTO crm_message_templates (id, store_id, label, body) VALUES ($1,$2,$3,$4) RETURNING id, label, body, created_at, updated_at',
            [generateId('tpl'), storeId, label, body],
        );
        res.status(201).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error('[crm] Error creating message template:', error);
        res.status(500).json({ message: 'Error creating message template' });
    }
};

export const updateMessageTemplate = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const label = String(req.body?.label || '').trim();
    const body = String(req.body?.body || '').trim();
    if (!label || !body) return res.status(400).json({ message: 'A template needs a name and a message.' });
    try {
        const result = await db.query(
            `UPDATE crm_message_templates SET label = $1, body = $2, updated_at = NOW()
              WHERE id = $3 AND store_id = $4 RETURNING id, label, body, created_at, updated_at`,
            [label, body, req.params.id, storeId],
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Template not found' });
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error('[crm] Error updating message template:', error);
        res.status(500).json({ message: 'Error updating message template' });
    }
};

export const deleteMessageTemplate = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    try {
        const result = await db.query(
            'DELETE FROM crm_message_templates WHERE id = $1 AND store_id = $2 RETURNING id',
            [req.params.id, storeId],
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Template not found' });
        res.status(200).json({ message: 'Template deleted' });
    } catch (error) {
        console.error('[crm] Error deleting message template:', error);
        res.status(500).json({ message: 'Error deleting message template' });
    }
};

/* ─────────────────────────── Customer email outreach ─────────────────────── */

const escapeHtml = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/**
 * Email a customer from the CRM. Free core (there is no email add-on); uses the
 * same transport as the rest of the platform and logs the attempt so the
 * customer profile can show one outreach history.
 */
export const sendCustomerEmail = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const { customerId, subject, message } = req.body as { customerId?: string; subject?: string; message?: string };
    let to = String((req.body as any)?.to || '').trim();

    if (!message || !message.trim()) return res.status(400).json({ message: 'Message text is required.' });

    let customerName = '';
    if (customerId) {
        const cust = await db.query('SELECT name, email FROM customers WHERE id = $1 AND store_id = $2', [customerId, storeId]);
        if (cust.rowCount === 0) return res.status(404).json({ message: 'Customer not found' });
        customerName = cust.rows[0].name;
        // The stored address wins over anything the client passed: this endpoint
        // may only reach the store's own customers.
        to = cust.rows[0].email || '';
    }
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        return res.status(400).json({ message: 'No valid email address on file for this customer.', code: 'NO_EMAIL' });
    }

    const storeResult = await db.query('SELECT name FROM stores WHERE id = $1', [storeId]);
    const storeName = storeResult.rows[0]?.name || 'Our store';
    const finalSubject = (subject && subject.trim()) || `A message from ${storeName}`;
    const body = message.trim();
    const html = `<div style="font-family:'Hanken Grotesk',Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#181c1e;">`
        + `${escapeHtml(body).replace(/\n/g, '<br/>')}`
        + `<p style="margin-top:24px;color:#434651;font-size:13px;">— ${escapeHtml(storeName)}</p></div>`;

    let sent = false;
    let error: string | null = null;
    try {
        sent = await sendEmail(to, finalSubject, html, body);
    } catch (e: any) {
        error = e?.message || 'Email transport failed.';
    }

    const id = generateId('cmail');
    try {
        await db.query(
            `INSERT INTO customer_emails (id, store_id, customer_id, recipient, subject, body, status, error, sent_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [id, storeId, customerId || null, to, finalSubject, body, sent ? 'sent' : 'failed', error, req.user?.id || null],
        );
    } catch (e: any) {
        // Logging must never fail an email that actually went out.
        console.warn('[crm] Failed to log customer email (non-fatal):', e.message);
    }

    if (req.user) {
        auditService.log(req.user, 'Customer Email Sent', `To ${to}${customerName ? ` ("${customerName}")` : ''} — ${sent ? 'sent' : 'failed'}`)
            .catch(() => { /* audit is best-effort */ });
    }

    if (!sent) {
        return res.status(502).json({ success: false, id, message: error || 'The email could not be delivered.' });
    }
    return res.status(200).json({ success: true, id, recipient: to, subject: finalSubject });
};

/**
 * One outreach timeline per customer: emails + SMS + WhatsApp, newest first.
 * Each source table is queried defensively — an un-migrated deployment missing
 * one of them should still show the others rather than erroring.
 */
export const getCustomerOutreach = async (req: express.Request, res: express.Response) => {
    const storeId = requireStore(req, res);
    if (!storeId) return;
    const { customerId } = req.query as { customerId?: string };

    const rows: any[] = [];

    const collect = async (sql: string, params: any[], map: (r: any) => any) => {
        try {
            const result = await db.query(sql, params);
            result.rows.forEach((r: any) => rows.push(map(r)));
        } catch (e: any) {
            console.warn('[crm] outreach source unavailable:', e.message);
        }
    };

    const custFilter = customerId ? ' AND customer_id = $2' : '';
    const params = customerId ? [storeId, customerId] : [storeId];

    await collect(
        `SELECT id, recipient, subject, body, status, created_at FROM customer_emails
          WHERE store_id = $1${custFilter} ORDER BY created_at DESC LIMIT 100`,
        params,
        r => ({
            id: r.id, channel: 'email', to: r.recipient, subject: r.subject,
            body: r.body, status: r.status, createdAt: r.created_at,
        }),
    );

    await collect(
        `SELECT id, recipient, message, status, cost, created_at FROM sms_messages
          WHERE store_id = $1${custFilter} ORDER BY created_at DESC LIMIT 100`,
        params,
        r => ({
            id: r.id, channel: 'sms', to: r.recipient, body: r.message,
            status: r.status, cost: r.cost, createdAt: r.created_at,
        }),
    );

    // WhatsApp lives in conversations/messages; only outbound rows are outreach.
    await collect(
        `SELECT m.id, m.content, m.status, m.direction, m.created_at, c.customer_phone
           FROM whatsapp_messages m
           JOIN whatsapp_conversations c ON c.id = m.conversation_id
          WHERE m.store_id = $1${customerId ? ' AND c.customer_id = $2' : ''}
          ORDER BY m.created_at DESC LIMIT 100`,
        params,
        r => ({
            id: r.id, channel: 'whatsapp', to: r.customer_phone, body: r.content,
            status: r.status, direction: r.direction, createdAt: r.created_at,
        }),
    );

    rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.status(200).json(rows.slice(0, 200));
};
