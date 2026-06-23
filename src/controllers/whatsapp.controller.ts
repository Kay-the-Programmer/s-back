
import express from 'express';
import crypto from 'crypto';
import whatsAppService from '../services/whatsapp.service';
import whatsAppAIService from '../services/whatsapp-ai.service';
import db from '../db_client';
import { MODULES, isModuleEnabled } from '../services/entitlements.service';
import { auditService } from '../services/audit.service';

/**
 * Meta app secret used to validate webhook payload signatures (X-Hub-Signature-256).
 * Single-app model: one platform app secret validates every store's webhooks.
 * If unset, validation is skipped (dev convenience) — set it in production.
 */
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || process.env.APP_SECRET || '';

/**
 * Verify the X-Hub-Signature-256 header is an HMAC-SHA256 of the raw request body
 * keyed with the app secret. Returns true when valid OR when no secret is
 * configured (so early testing isn't blocked). Constant-time comparison.
 */
const isValidSignature = (req: express.Request): boolean => {
    if (!WHATSAPP_APP_SECRET) {
        console.warn('[whatsapp] WHATSAPP_APP_SECRET not set — skipping webhook signature check.');
        return true;
    }
    const header = req.header('x-hub-signature-256') || '';
    const raw = (req as any).rawBody as Buffer | undefined;
    if (!header || !raw) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', WHATSAPP_APP_SECRET).update(raw).digest('hex');
    if (header.length !== expected.length) return false;
    try {
        return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
    } catch {
        return false;
    }
};

/**
 * DEV OVERRIDE: WhatsApp messaging is free while the team is building/testing the
 * CRM integration, so no one hits the premium paywall. Defaults to FREE; set
 * `WHATSAPP_FREE=false` in the environment (and `VITE_WHATSAPP_FREE=false` on the
 * frontend) to re-enable the paid add-on before charging for it.
 */
const WHATSAPP_FREE = process.env.WHATSAPP_FREE !== 'false';

/** Whether a store may use WhatsApp — honours the dev free-override. */
const isWhatsappEntitled = async (storeId?: string | null): Promise<boolean> =>
    WHATSAPP_FREE || isModuleEnabled(storeId, MODULES.WHATSAPP_MESSAGING);

// Webhook Verification (GET)
export const verifyWebhook = async (req: express.Request, res: express.Response) => {
    try {
        const mode = req.query['hub.mode'];
        const token = req.query['hub.verify_token'];
        const challenge = req.query['hub.challenge'];

        // In a real multi-tenant scenario, we might need a central verification token 
        // OR search which store matches this token. 
        // For simplicity, we assume a system-wide env var for verification 
        // OR we query DB to find if ANY store has this verify token.
        // Let's use a system-wide fallback or check against database.

        let isValid = false;

        // Check system level env first (easiest for single setup)
        if (process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN && token === process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN) {
            isValid = true;
        } else {
            // Check database for specific store configuration matching this token
            const result = await db.query('SELECT store_id FROM whatsapp_config WHERE webhook_verify_token = $1', [token]);
            if (result.rows.length > 0) isValid = true;
        }

        if (mode === 'subscribe' && isValid) {
            console.log('Webhook verified successfully');
            res.status(200).send(challenge);
        } else {
            res.sendStatus(403);
        }
    } catch (error) {
        console.error('Webhook verification error:', error);
        res.sendStatus(500);
    }
};

// Webhook Event Handler (POST)
export const handleWebhook = async (req: express.Request, res: express.Response) => {
    try {
        // Reject forged payloads before trusting any of their contents.
        if (!isValidSignature(req)) {
            console.warn('[whatsapp] webhook signature mismatch — rejecting.');
            return res.sendStatus(401);
        }

        const body = req.body;

        // Meta Cloud API payloads
        if (body.object === 'whatsapp_business_account') {

            // Iterate over entries (usually 1)
            for (const entry of body.entry) {
                // Determine store ID from phone number ID or business account ID
                // The payload contains `changes[0].value.metadata.phone_number_id`

                for (const change of entry.changes) {
                    const value = change.value;
                    const phoneNumberId = value.metadata?.phone_number_id;

                    if (value.messages) {
                        // Find store config by phone_number_id
                        const storeResult = await db.query(
                            'SELECT store_id, is_enabled, auto_reply_enabled FROM whatsapp_config WHERE phone_number_id = $1',
                            [phoneNumberId]
                        );

                        if (storeResult.rows.length === 0) {
                            console.warn(`Received message for unknown phone_number_id: ${phoneNumberId}`);
                            continue;
                        }

                        const storeConfig = storeResult.rows[0];
                        const storeId = storeConfig.store_id;

                        if (!storeConfig.is_enabled) continue;

                        for (const message of value.messages) {
                            const from = message.from; // Customer phone
                            const messageBody = message.text?.body || ''; // For text messages
                            const messageType = message.type;

                            // 1. Get/Create Conversation
                            const customerName = value.contacts?.[0]?.profile?.name;
                            const conversationId = await whatsAppService.getOrCreateConversation(storeId, from, customerName);

                            // 2. Log Incoming Message
                            await whatsAppService.logMessage(
                                conversationId,
                                storeId,
                                'inbound',
                                messageType,
                                messageBody,
                                message.id,
                                'delivered'
                            );

                            // --- Push Notification for Staff ---
                            try {
                                const { pushService } = await import('../services/push.service');
                                let userRes;
                                if (storeId === 'system') {
                                    userRes = await db.query("SELECT id FROM users WHERE role = 'superadmin'");
                                } else {
                                    userRes = await db.query('SELECT id FROM users WHERE current_store_id = $1', [storeId]);
                                }
                                const userIds = userRes.rows.map(u => u.id);
                                if (userIds.length > 0) {
                                    await pushService.sendToUsers(userIds, {
                                        title: `New WhatsApp: ${customerName || from}`,
                                        body: messageBody || `Received ${messageType} message`,
                                        url: `/whatsapp/${conversationId}`
                                    });
                                }
                            } catch (pushErr) {
                                console.error('Push failed for inbound WhatsApp:', pushErr);
                            }

                            // 3. Trigger AI Auto-Reply (if enabled)
                            if (storeConfig.auto_reply_enabled && messageType === 'text') {
                                // Async processing - don't block 200 OK to WhatsApp
                                whatsAppAIService.handleIncomingMessage(storeId, from, messageBody, conversationId)
                                    .catch(err => console.error('Background AI processing failed:', err));
                            }
                        }
                    } else if (value.statuses) {
                        // Handle message status updates (sent, delivered, read, failed)
                        for (const status of value.statuses) {
                            await whatsAppService.updateMessageStatus(status.id, status.status);
                        }
                    }
                }
            }

            res.sendStatus(200);
        } else {
            res.sendStatus(404);
        }
    } catch (error) {
        console.error('Webhook handler error:', error);
        res.sendStatus(500);
    }
};

// --- Config Endpoints ---

export const getConfiguration = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'Store ID required' });

        const config = await whatsAppService.getStoreConfig(storeId);
        if (!config) return res.json({});

        // The Meta access token is a secret and must never be echoed back to the
        // browser (write-only). Tell the UI only whether one is set.
        const { access_token, ...rest } = config;
        res.json({ ...rest, access_token: '', access_token_set: !!(access_token && access_token !== 'system') });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch config' });
    }
};

export const updateConfiguration = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'Store ID required' });

        // Write-only secret: a blank token means "keep the existing one" — never
        // overwrite a stored token with an empty value.
        const payload = { ...req.body };
        if (!payload.access_token || !String(payload.access_token).trim()) {
            delete payload.access_token;
        }

        await whatsAppService.updateStoreConfig(storeId, payload);
        res.json({ message: 'Configuration updated successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update config' });
    }
};

/**
 * Lightweight, no-secrets connection status for the CRM. Mirrors GET /sms/config:
 * tells the client whether WhatsApp is connected, switched on, and entitled —
 * so it can show the right inbox/upsell state without ever seeing credentials.
 */
export const getStatus = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const entitled = await isWhatsappEntitled(storeId);

        let configured = false;
        let enabled = false;
        let displayPhoneNumber: string | null = null;

        if (storeId) {
            const config = await whatsAppService.getStoreConfig(storeId);
            if (config) {
                configured = !!(config.access_token && config.phone_number_id);
                enabled = !!config.is_enabled;
                displayPhoneNumber = config.display_phone_number || null;
            }
        }

        res.json({ configured, enabled, entitled, displayPhoneNumber });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch WhatsApp status' });
    }
};

// --- Conversation Endpoints ---

export const getConversations = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const isSystemRequest = req.query.system === 'true' && req.user?.role === 'superadmin';

        if (!storeId && !isSystemRequest) return res.status(400).json({ message: 'Store ID required' });

        const targetStoreId = (isSystemRequest ? 'system' : storeId) as string;

        const result = await db.query(
            `SELECT * FROM whatsapp_conversations 
             WHERE store_id = $1 
             ORDER BY last_message_at DESC LIMIT 50`,
            [targetStoreId]
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch conversations' });
    }
};

export const getMessages = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const { id } = req.params; // Conversation ID
        const isSystemRequest = req.query.system === 'true' && req.user?.role === 'superadmin';

        const targetStoreId = (isSystemRequest ? 'system' : storeId) as string;

        // Security check: ensure conversation belongs to store
        const check = await db.query('SELECT 1 FROM whatsapp_conversations WHERE id = $1 AND store_id = $2', [id, targetStoreId]);
        if (check.rows.length === 0) return res.status(403).json({ message: 'Access denied' });

        const messages = await db.query(
            `SELECT * FROM whatsapp_messages 
             WHERE conversation_id = $1 
             ORDER BY created_at ASC`,
            [id]
        );
        res.json(messages.rows);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch messages' });
    }
};

/**
 * Send an outbound WhatsApp message. Accepts two shapes:
 *   • Reply in a thread (inbox):   { conversationId, content }
 *   • New message to a customer:   { to, message, customerId }
 * The superadmin support desk passes `system: true` to act as the platform.
 */
export const sendManualMessage = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const { conversationId, content, message, to, customerId, system } = req.body as {
            conversationId?: string; content?: string; message?: string;
            to?: string; customerId?: string; system?: boolean;
        };
        const isSystemRequest = system === true && req.user?.role === 'superadmin';

        if (!storeId && !isSystemRequest) return res.status(400).json({ message: 'Store ID required' });

        const targetStoreId = (isSystemRequest ? 'system' : storeId) as string;

        // Premium gate for store users (the platform support desk is exempt).
        // Bypassed while WHATSAPP_FREE is on (dev/testing).
        if (!isSystemRequest && !(await isWhatsappEntitled(storeId))) {
            return res.status(402).json({
                success: false,
                message: 'WhatsApp messaging is a premium feature. Unlock it to message customers.',
                code: 'MODULE_LOCKED',
                module: MODULES.WHATSAPP_MESSAGING,
            });
        }

        const body = (content ?? message ?? '').trim();
        if (!body) return res.status(400).json({ success: false, message: 'Message text is required.' });

        // Resolve the conversation + recipient phone.
        let convId = conversationId;
        let recipient: string;

        if (convId) {
            const conv = await db.query('SELECT customer_phone FROM whatsapp_conversations WHERE id = $1 AND store_id = $2', [convId, targetStoreId]);
            if (conv.rows.length === 0) return res.status(404).json({ success: false, message: 'Conversation not found' });
            recipient = conv.rows[0].customer_phone;
        } else {
            if (!to || !to.trim()) return res.status(400).json({ success: false, message: 'A recipient phone number is required.' });
            recipient = to.trim();
            convId = await whatsAppService.getOrCreateConversation(targetStoreId, recipient);
            // Link the CRM customer if the caller knows it (don't clobber an existing link).
            if (customerId) {
                await db.query(
                    'UPDATE whatsapp_conversations SET customer_id = COALESCE(customer_id, $1) WHERE id = $2',
                    [customerId, convId],
                );
            }
        }

        const apiResp = await whatsAppService.sendTextMessage(targetStoreId, recipient, body);
        const waMessageId = apiResp?.messages?.[0]?.id;
        await whatsAppService.logMessage(convId!, targetStoreId, 'outbound', 'text', body, waMessageId, 'sent', false);

        if (req.user) {
            auditService.log(req.user, 'WhatsApp Sent', `To ${recipient}${customerId ? ` (customer ${customerId})` : ''}`)
                .catch(() => { /* audit is best-effort */ });
        }

        res.json({ success: true, conversationId: convId, messageId: waMessageId || null, status: 'sent' });
    } catch (error: any) {
        // A Meta API rejection (e.g. outside the 24h window) is a 502, not a server bug.
        res.status(502).json({ success: false, message: error.message || 'Failed to send message' });
    }
};

/**
 * WhatsApp message history for the current store, optionally filtered to one CRM
 * customer (joined through the conversation). Reserved for a profile timeline.
 */
export const getMessageHistory = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'No store selected.' });
        const { customerId } = req.query as { customerId?: string };

        let result;
        if (customerId) {
            result = await db.query(
                `SELECT m.* FROM whatsapp_messages m
                 JOIN whatsapp_conversations c ON m.conversation_id = c.id
                 WHERE c.store_id = $1 AND c.customer_id = $2
                 ORDER BY m.created_at DESC LIMIT 200`,
                [storeId, customerId],
            );
        } else {
            result = await db.query(
                'SELECT * FROM whatsapp_messages WHERE store_id = $1 ORDER BY created_at DESC LIMIT 200',
                [storeId],
            );
        }
        res.json(result.rows);
    } catch (error: any) {
        // Table may not exist yet on an un-migrated deployment — empty, not 500.
        console.warn('[whatsapp] history query failed:', error.message);
        res.json([]);
    }
};

export const getSupportContact = async (req: express.Request, res: express.Response) => {
    try {
        // Fetch config for the SYSTEM store (superadmin support)
        const result = await db.query(
            'SELECT display_phone_number, greeting_message, phone_number_id, access_token, webhook_verify_token FROM whatsapp_config WHERE store_id = $1',
            ['system']
        );

        if (result.rows.length === 0 || !result.rows[0].display_phone_number) {
            return res.status(404).json({ message: 'Support contact not configured' });
        }

        const config = result.rows[0];
        // The Meta access token is a secret and is never returned to the browser (write-only).
        // We only tell the UI whether one is configured so it can show a hint.
        const hasToken = !!(config.access_token && config.access_token !== 'system');

        res.json({
            phone: config.display_phone_number,
            message: config.greeting_message,
            phone_number_id: config.phone_number_id,
            webhook_verify_token: config.webhook_verify_token,
            access_token: '',
            access_token_set: hasToken
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch support contact' });
    }
};

export const updateSupportContact = async (req: express.Request, res: express.Response) => {
    try {
        if (req.user?.role !== 'superadmin') {
            return res.status(403).json({ message: 'Only superadmins can configure support contact' });
        }

        const { phone, message, phone_number_id, access_token, webhook_verify_token } = req.body;

        if (!phone) return res.status(400).json({ message: 'Phone number is required' });

        // Write-only secret: a blank token means "keep the existing one" rather than wiping it.
        let tokenToStore = (access_token || '').trim();
        if (!tokenToStore) {
            const existing = await whatsAppService.getStoreConfig('system');
            tokenToStore = existing?.access_token || 'system';
        }

        await whatsAppService.updateStoreConfig('system', {
            store_id: 'system',
            display_phone_number: phone,
            greeting_message: message,
            phone_number_id: phone_number_id || 'system_placeholder',
            webhook_verify_token: webhook_verify_token || 'system',
            access_token: tokenToStore,
            is_enabled: true,
            auto_reply_enabled: false
        });

        res.json({ message: 'Support contact updated successfully' });
    } catch (error) {
        console.error('Update support contact error:', error);
        res.status(500).json({ message: 'Failed to update support contact' });
    }
};
