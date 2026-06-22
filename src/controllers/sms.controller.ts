import express from 'express';
import db from '../db_client';
import { smsService } from '../services/sms.service';
import { auditService } from '../services/audit.service';
import { MODULES, isModuleEnabled } from '../services/entitlements.service';
import { generateId, toCamelCase } from '../utils/helpers';

/**
 * Persist an SMS attempt. Best-effort: a logging failure (e.g. the table not
 * yet migrated) must never fail an SMS that was actually sent.
 */
const logSms = async (row: {
    storeId?: string; customerId?: string | null; recipient: string; message: string;
    status: string; providerMessageId?: string | null; cost?: string | null; error?: string | null; sentBy?: string | null;
}) => {
    try {
        const id = generateId('sms');
        await db.query(
            `INSERT INTO sms_messages (id, store_id, customer_id, recipient, message, status, provider, provider_message_id, cost, error, sent_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [id, row.storeId || null, row.customerId || null, row.recipient, row.message, row.status,
                'africastalking', row.providerMessageId || null, row.cost || null, row.error || null, row.sentBy || null],
        );
        return id;
    } catch (e: any) {
        console.warn('[sms] Failed to persist SMS log (non-fatal):', e.message);
        return null;
    }
};

export const getSmsConfig = async (req: express.Request, res: express.Response) => {
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    const entitled = await isModuleEnabled(storeId, MODULES.SMS_MESSAGING);
    res.status(200).json({ ...smsService.publicConfig(), entitled });
};

export const sendSms = async (req: express.Request, res: express.Response) => {
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    const { to, message, customerId } = req.body as { to?: string; message?: string; customerId?: string };

    if (!to || !to.trim()) return res.status(400).json({ message: 'A recipient phone number is required.' });
    if (!message || !message.trim()) return res.status(400).json({ message: 'Message text is required.' });

    // Premium gate: SMS messaging is a paid add-on (402 Payment Required when locked).
    if (!(await isModuleEnabled(storeId, MODULES.SMS_MESSAGING))) {
        return res.status(402).json({
            message: 'SMS messaging is a premium feature. Unlock it to send messages to customers.',
            code: 'MODULE_LOCKED',
            module: MODULES.SMS_MESSAGING,
        });
    }

    if (!smsService.isConfigured()) {
        return res.status(503).json({ message: 'SMS is not configured for this server. Add Africa\'s Talking credentials.', code: 'SMS_NOT_CONFIGURED' });
    }

    const recipient = smsService.normalizePhone(to);
    if (!recipient) return res.status(400).json({ message: 'Invalid recipient phone number.' });

    try {
        const result = await smsService.sendSms(recipient, message.trim());
        const first = result.recipients[0];
        const status = first?.status || 'Submitted';
        const ok = /success|sent|submitted/i.test(status);

        const logId = await logSms({
            storeId, customerId, recipient, message: message.trim(),
            status: ok ? status : `Failed: ${status}`,
            providerMessageId: first?.messageId, cost: first?.cost, sentBy: req.user?.id,
        });

        if (req.user) {
            auditService.log(req.user, 'SMS Sent', `To ${recipient}${customerId ? ` (customer ${customerId})` : ''} — ${status}`)
                .catch(() => { /* audit is best-effort */ });
        }

        return res.status(ok ? 200 : 502).json({
            success: ok,
            id: logId,
            recipient,
            status,
            cost: first?.cost,
            messageId: first?.messageId,
            providerMessage: result.message,
        });
    } catch (error: any) {
        const code = error?.code || 'SMS_ERROR';
        const msg = error?.message || 'Failed to send SMS.';
        await logSms({ storeId, customerId, recipient, message: message.trim(), status: 'Failed', error: msg, sentBy: req.user?.id });
        console.error('[sms] send error:', msg);
        const httpStatus = code === 'SMS_NOT_CONFIGURED' ? 503 : 502;
        return res.status(httpStatus).json({ success: false, message: msg, code });
    }
};

export const getSmsHistory = async (req: express.Request, res: express.Response) => {
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'No store selected.' });
    const { customerId } = req.query as { customerId?: string };

    try {
        const params: any[] = [storeId];
        let where = 'store_id = $1';
        if (customerId) { params.push(customerId); where += ` AND customer_id = $${params.length}`; }
        const result = await db.query(
            `SELECT * FROM sms_messages WHERE ${where} ORDER BY created_at DESC LIMIT 200`,
            params,
        );
        return res.status(200).json(toCamelCase(result.rows));
    } catch (error: any) {
        // Table may not exist yet on un-migrated deployments — return an empty list rather than 500.
        console.warn('[sms] history query failed:', error.message);
        return res.status(200).json([]);
    }
};
