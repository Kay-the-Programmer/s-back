
import express from 'express';
import whatsAppService from '../services/whatsapp.service';
import whatsAppAIService from '../services/whatsapp-ai.service';
import db from '../db_client';

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
                        // Handle message status updates (sent, delivered, read)
                        // TODO: Update whatsapp_messages table status based on message_id
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
        res.json(config || {});
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch config' });
    }
};

export const updateConfiguration = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'Store ID required' });

        await whatsAppService.updateStoreConfig(storeId, req.body);
        res.json({ message: 'Configuration updated successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update config' });
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

export const sendManualMessage = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const { conversationId, content, system } = req.body;
        const isSystemRequest = system === true && req.user?.role === 'superadmin';

        if (!storeId && !isSystemRequest) return res.status(400).json({ message: 'Store ID required' });

        const targetStoreId = (isSystemRequest ? 'system' : storeId) as string;

        // Get customer phone from conversation
        const conv = await db.query('SELECT customer_phone FROM whatsapp_conversations WHERE id = $1 AND store_id = $2', [conversationId, targetStoreId]);
        if (conv.rows.length === 0) return res.status(404).json({ message: 'Conversation not found' });

        const to = conv.rows[0].customer_phone;

        await whatsAppService.sendTextMessage(targetStoreId, to, content);
        await whatsAppService.logMessage(conversationId, targetStoreId, 'outbound', 'text', content, undefined, 'sent', false);

        res.json({ message: 'Message sent' });
    } catch (error: any) {
        res.status(500).json({ message: error.message || 'Failed to send message' });
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
        // Decrypt the token correctly using the service before sending back if needed for UI (though usually not returned plainly)
        // For settings page, we may want to show if it's set or part of it, or just allow overwrite.
        // We will return it, but maybe the service method should be used for safety. Let's use the decrypt from service.
        let accessToken = config.access_token;
        if (accessToken) {
            accessToken = await whatsAppService.getStoreConfig('system').then(c => c?.access_token || '');
        }

        res.json({
            phone: config.display_phone_number,
            message: config.greeting_message,
            phone_number_id: config.phone_number_id,
            webhook_verify_token: config.webhook_verify_token,
            access_token: accessToken || ''
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

        await whatsAppService.updateStoreConfig('system', {
            store_id: 'system',
            display_phone_number: phone,
            greeting_message: message,
            phone_number_id: phone_number_id || 'system_placeholder',
            webhook_verify_token: webhook_verify_token || 'system',
            access_token: access_token || 'system',
            is_enabled: true,
            auto_reply_enabled: false
        });

        res.json({ message: 'Support contact updated successfully' });
    } catch (error) {
        console.error('Update support contact error:', error);
        res.status(500).json({ message: 'Failed to update support contact' });
    }
};
