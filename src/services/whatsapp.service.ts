
import axios from 'axios';
import db from '../db_client';
import CryptoJS from 'crypto-js';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-secret-key-change-in-prod';

export interface WhatsAppConfig {
    store_id: string;
    phone_number_id: string;
    access_token: string;
    business_account_id?: string;
    webhook_verify_token: string;
    is_enabled: boolean;
    auto_reply_enabled: boolean;
    business_hours?: any;
    away_message?: string;
    display_phone_number?: string;
    greeting_message?: string;
}

export class WhatsAppService {

    // --- Configuration Section ---

    private encryptToken(token: string): string {
        return CryptoJS.AES.encrypt(token, ENCRYPTION_KEY).toString();
    }

    private decryptToken(encryptedToken: string): string {
        try {
            const bytes = CryptoJS.AES.decrypt(encryptedToken, ENCRYPTION_KEY);
            return bytes.toString(CryptoJS.enc.Utf8);
        } catch (error) {
            console.error('Error decrypting token:', error);
            return '';
        }
    }

    async getStoreConfig(storeId: string): Promise<WhatsAppConfig | null> {
        const result = await db.query(
            'SELECT * FROM whatsapp_config WHERE store_id = $1',
            [storeId]
        );
        if (result.rows.length === 0) return null;

        const config = result.rows[0];
        // Decrypt token for internal use, but we might not want to return it to UI masked
        config.access_token = this.decryptToken(config.access_token);
        return config;
    }

    async updateStoreConfig(storeId: string, config: Partial<WhatsAppConfig>): Promise<void> {
        // If updating token, encrypt it first
        let accessToken = config.access_token;
        if (accessToken) {
            accessToken = this.encryptToken(accessToken);
        }

        const query = `
            INSERT INTO whatsapp_config (
                store_id, phone_number_id, access_token, business_account_id, webhook_verify_token, 
                is_enabled, auto_reply_enabled, business_hours, away_message, greeting_message, display_phone_number, updated_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
            ON CONFLICT (store_id) DO UPDATE SET
                phone_number_id = COALESCE(EXCLUDED.phone_number_id, whatsapp_config.phone_number_id),
                access_token = COALESCE(EXCLUDED.access_token, whatsapp_config.access_token),
                business_account_id = COALESCE(EXCLUDED.business_account_id, whatsapp_config.business_account_id),
                webhook_verify_token = COALESCE(EXCLUDED.webhook_verify_token, whatsapp_config.webhook_verify_token),
                is_enabled = COALESCE(EXCLUDED.is_enabled, whatsapp_config.is_enabled),
                auto_reply_enabled = COALESCE(EXCLUDED.auto_reply_enabled, whatsapp_config.auto_reply_enabled),
                business_hours = COALESCE(EXCLUDED.business_hours, whatsapp_config.business_hours),
                away_message = COALESCE(EXCLUDED.away_message, whatsapp_config.away_message),
                greeting_message = COALESCE(EXCLUDED.greeting_message, whatsapp_config.greeting_message),
                display_phone_number = COALESCE(EXCLUDED.display_phone_number, whatsapp_config.display_phone_number),
                updated_at = NOW()
        `;

        // We need existing values if this is a partial update and valid token is not provided
        // But for simplicity in ON CONFLICT implementation we can rely on COALESCE provided we pass NULL for undefined

        // However, standard SQL parameters matching is safer if we fetch existing or just assume full payload from controller
        // Let's assume the controller passes valid encrypted or new values. 
        // For a true partial update where we don't know the other fields, fetching first is best or dynamic query construction.
        // Dynamic query is better here.

        const fields: string[] = [];
        const values: any[] = [];
        let idx = 1;

        if (config.phone_number_id) { fields.push(`phone_number_id = $${idx++}`); values.push(config.phone_number_id); }
        if (accessToken) { fields.push(`access_token = $${idx++}`); values.push(accessToken); }
        if (config.business_account_id !== undefined) { fields.push(`business_account_id = $${idx++}`); values.push(config.business_account_id); }
        if (config.webhook_verify_token) { fields.push(`webhook_verify_token = $${idx++}`); values.push(config.webhook_verify_token); }
        if (config.is_enabled !== undefined) { fields.push(`is_enabled = $${idx++}`); values.push(config.is_enabled); }
        if (config.auto_reply_enabled !== undefined) { fields.push(`auto_reply_enabled = $${idx++}`); values.push(config.auto_reply_enabled); }
        if (config.business_hours) { fields.push(`business_hours = $${idx++}`); values.push(config.business_hours); }
        if (config.away_message !== undefined) { fields.push(`away_message = $${idx++}`); values.push(config.away_message); }
        if (config.greeting_message !== undefined) { fields.push(`greeting_message = $${idx++}`); values.push(config.greeting_message); }
        if (config.display_phone_number !== undefined) { fields.push(`display_phone_number = $${idx++}`); values.push(config.display_phone_number); }

        if (fields.length === 0) return;

        fields.push(`updated_at = NOW()`);

        // Check if exists
        const exists = await db.query('SELECT 1 FROM whatsapp_config WHERE store_id = $1', [storeId]);

        if (exists.rows.length === 0) {
            // Insert (Caller of this method should ideally ensure critical fields are present for new insert)
            // For robust partial update on non-existent record, we might fail DB constraints.
            // Let's assume controller handles validation.
            // But simpler logic: UPSERT with explicit query above is better if we have all data.
            // Since we want to support partial updates easily, let's use the dynamic update if exists, else insert.
            // For now, let's fallback to the full UPSERT query with specific params handling in controller or detailed service method.
            // Reverting to the static UPSERT assumption that critical fields are provided or we fetch existing.

            // Actually, let's stick to the simpler static query but handle undefined params by passing null to SQL but existing columns need handling.
            // Recommendation: Just run the upsert with COALESCE as initially planned, but pass NULL for undefined properties.
            const params = [
                storeId,
                config.phone_number_id || null,
                accessToken || null,
                config.business_account_id || null,
                config.webhook_verify_token || null,
                config.is_enabled, // might be undefined, will be passed as null
                config.auto_reply_enabled,
                JSON.stringify(config.business_hours) || null,
                config.away_message || null,
                config.greeting_message || null,
                config.display_phone_number || null
            ];

            // Note: pg driver treats undefined as null for parameters usually? No, it throws. We must ensure null.
            const cleanParams = params.map(p => p === undefined ? null : p);

            await db.query(`
                INSERT INTO whatsapp_config (
                    store_id, phone_number_id, access_token, business_account_id, webhook_verify_token, 
                    is_enabled, auto_reply_enabled, business_hours, away_message, greeting_message, display_phone_number, updated_at
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
                ON CONFLICT (store_id) DO UPDATE SET
                    phone_number_id = COALESCE($2, whatsapp_config.phone_number_id),
                    access_token = COALESCE($3, whatsapp_config.access_token),
                    business_account_id = COALESCE($4, whatsapp_config.business_account_id),
                    webhook_verify_token = COALESCE($5, whatsapp_config.webhook_verify_token),
                    is_enabled = COALESCE($6, whatsapp_config.is_enabled),
                    auto_reply_enabled = COALESCE($7, whatsapp_config.auto_reply_enabled),
                    business_hours = COALESCE($8, whatsapp_config.business_hours),
                    away_message = COALESCE($9, whatsapp_config.away_message),
                    greeting_message = COALESCE($10, whatsapp_config.greeting_message),
                    display_phone_number = COALESCE($11, whatsapp_config.display_phone_number),
                    updated_at = NOW()
            `, cleanParams);
        } else {
            // Standard dynamic update
            let updateQuery = 'UPDATE whatsapp_config SET ';
            const updateValues = [];
            let i = 1;

            for (const [key, value] of Object.entries(config)) {
                if (key === 'access_token') {
                    updateQuery += `access_token = $${i++}, `;
                    updateValues.push(this.encryptToken(value as string));
                } else if (value !== undefined) {
                    updateQuery += `${key} = $${i++}, `;
                    updateValues.push(key === 'business_hours' ? JSON.stringify(value) : value);
                }
            }
            updateQuery += `updated_at = NOW() WHERE store_id = $${i}`;
            updateValues.push(storeId);

            await db.query(updateQuery, updateValues);
        }
    }

    // --- Messaging Section ---

    async sendMessage(storeId: string, to: string, messageData: any): Promise<any> {
        const config = await this.getStoreConfig(storeId);
        if (!config || !config.is_enabled || !config.access_token || !config.phone_number_id) {
            throw new Error('WhatsApp not configured or enabled for this store');
        }

        // Graph API version is overridable so we can bump it without a code change
        // when Meta deprecates an older one.
        const version = process.env.WHATSAPP_GRAPH_API_VERSION || 'v21.0';
        const url = `https://graph.facebook.com/${version}/${config.phone_number_id}/messages`;

        try {
            const response = await axios.post(url, {
                messaging_product: 'whatsapp',
                to: to,
                ...messageData
            }, {
                headers: {
                    'Authorization': `Bearer ${config.access_token}`,
                    'Content-Type': 'application/json'
                }
            });

            return response.data;
        } catch (error: any) {
            const apiErr = error.response?.data?.error;
            console.error('Meta API Error:', error.response?.data || error.message);

            if (apiErr) {
                const code = apiErr.code;
                const detail = `${apiErr.message || 'Unknown error'}${code != null ? ` (code ${code}${apiErr.error_subcode ? `/${apiErr.error_subcode}` : ''})` : ''}`;
                // Token/permission failures: give an actionable hint instead of a bare relay.
                if (apiErr.type === 'OAuthException' || code === 190 || code === 200 || code === 10 || code === 0) {
                    throw new Error(
                        `WhatsApp authentication failed: ${detail}. The access token is invalid, expired, or lacks the ` +
                        `whatsapp_business_messaging permission. Reconnect with a permanent System User token in WhatsApp → Connect.`,
                    );
                }
                // Test/development mode: only verified test recipients can be messaged.
                if (code === 131030) {
                    throw new Error(
                        `Recipient not allowed: ${detail}. Your WhatsApp app is in test mode, which only sends to numbers ` +
                        `added as test recipients in Meta. Add this number to the allowed list, or take the app Live with a ` +
                        `registered business number to message any customer.`,
                    );
                }
                throw new Error(`Failed to send WhatsApp message: ${detail}`);
            }
            throw new Error('Failed to send WhatsApp message: ' + (error.message || 'network error'));
        }
    }

    async sendTextMessage(storeId: string, to: string, text: string): Promise<any> {
        return this.sendMessage(storeId, to, {
            type: 'text',
            text: { body: text }
        });
    }

    /**
     * Send an approved template message — the only way to message a customer
     * outside the 24h service window (i.e. proactive marketing). `bodyParams`
     * fill the template's {{1}}, {{2}}… body variables in order.
     */
    async sendTemplateMessage(storeId: string, to: string, templateName: string, langCode = 'en_US', bodyParams: string[] = []): Promise<any> {
        const components = bodyParams.length
            ? [{ type: 'body', parameters: bodyParams.map(t => ({ type: 'text', text: t })) }]
            : [];
        return this.sendMessage(storeId, to, {
            type: 'template',
            template: {
                name: templateName,
                language: { code: langCode },
                ...(components.length ? { components } : {}),
            },
        });
    }

    // --- Conversation & Message Storage ---

    async getOrCreateConversation(storeId: string, customerPhone: string, customerName?: string): Promise<string> {
        // Check if exists
        const existing = await db.query(
            'SELECT id FROM whatsapp_conversations WHERE store_id = $1 AND customer_phone = $2',
            [storeId, customerPhone]
        );

        if (existing.rows.length > 0) {
            return existing.rows[0].id;
        }

        // Create new
        const id = `conv_${Math.random().toString(36).substr(2, 9)}`;

        // Try to link to existing customer
        // Note: Basic exact match on phone. Ideally normalize phone formats.
        const customerSearch = await db.query(
            'SELECT id, name FROM customers WHERE store_id = $1 AND (phone = $2 OR phone LIKE $3)',
            [storeId, customerPhone, `%${customerPhone.slice(-8)}`] // Simple loose match
        );

        let customerId = null;
        let finalName = customerName;

        if (customerSearch.rows.length > 0) {
            customerId = customerSearch.rows[0].id;
            if (!finalName) finalName = customerSearch.rows[0].name;
        }

        await db.query(
            `INSERT INTO whatsapp_conversations (
                id, store_id, customer_phone, customer_name, customer_id, status, created_at, last_message_at
            ) VALUES ($1, $2, $3, $4, $5, 'active', NOW(), NOW())`,
            [id, storeId, customerPhone, finalName, customerId]
        );

        return id;
    }

    async logMessage(
        conversationId: string,
        storeId: string,
        direction: 'inbound' | 'outbound',
        messageType: string,
        content: string,
        whatsappMessageId?: string,
        status: string = 'sent',
        isAiGenerated: boolean = false
    ): Promise<string> {
        const id = `msg_${Math.random().toString(36).substr(2, 9)}`;

        await db.query(
            `INSERT INTO whatsapp_messages (
                id, conversation_id, store_id, direction, message_type, content, whatsapp_message_id, status, is_ai_generated, created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
            [id, conversationId, storeId, direction, messageType, content, whatsappMessageId, status, isAiGenerated]
        );

        // Update conversation timestamp
        await db.query(
            'UPDATE whatsapp_conversations SET last_message_at = NOW() WHERE id = $1',
            [conversationId]
        );

        return id;
    }

    /**
     * Update an outbound message's delivery state from a webhook `statuses[]`
     * event (sent → delivered → read, or failed). Keyed on the WhatsApp message
     * id (`wamid.*`) returned when we sent it. Best-effort — never throws.
     */
    async updateMessageStatus(whatsappMessageId: string, status: string): Promise<void> {
        if (!whatsappMessageId || !status) return;
        try {
            await db.query(
                'UPDATE whatsapp_messages SET status = $1 WHERE whatsapp_message_id = $2',
                [status, whatsappMessageId]
            );
        } catch (error: any) {
            console.warn('[whatsapp] failed to update message status (non-fatal):', error.message);
        }
    }
}

export default new WhatsAppService();
