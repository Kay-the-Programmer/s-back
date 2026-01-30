
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
        if (!storeId) return res.status(400).json({ message: 'Store ID required' });

        const result = await db.query(
            `SELECT * FROM whatsapp_conversations 
             WHERE store_id = $1 
             ORDER BY last_message_at DESC LIMIT 50`,
            [storeId]
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

        // Security check: ensure conversation belongs to store
        const check = await db.query('SELECT 1 FROM whatsapp_conversations WHERE id = $1 AND store_id = $2', [id, storeId]);
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
        if (!storeId) return res.status(400).json({ message: 'Store ID required' });

        const { conversationId, content } = req.body;

        // Get customer phone from conversation
        const conv = await db.query('SELECT customer_phone FROM whatsapp_conversations WHERE id = $1 AND store_id = $2', [conversationId, storeId]);
        if (conv.rows.length === 0) return res.status(404).json({ message: 'Conversation not found' });

        const to = conv.rows[0].customer_phone;

        await whatsAppService.sendTextMessage(storeId, to, content);
        await whatsAppService.logMessage(conversationId, storeId, 'outbound', 'text', content, undefined, 'sent', false);

        res.json({ message: 'Message sent' });
    } catch (error: any) {
        res.status(500).json({ message: error.message || 'Failed to send message' });
    }
};
