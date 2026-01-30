
import db from '../db_client';
import { GoogleGenerativeAI } from "@google/generative-ai";
import whatsAppService from './whatsapp.service';

const genAI = new GoogleGenerativeAI(process.env.API_KEY || '');

export class WhatsAppAIService {

    private async gatherCustomerContext(storeId: string, customerPhone: string, customerId?: string) {
        // Recent Orders
        let recentOrders = [];
        if (customerId) {
            const orders = await db.query(
                `SELECT transaction_id, total, status, created_at, payment_status, item_count 
                 FROM sales 
                 WHERE store_id = $1 AND customer_id = $2 
                 ORDER BY timestamp DESC LIMIT 3`,
                [storeId, customerId]
            );
            recentOrders = orders.rows;
        }

        // Store Info
        const storeSettings = await db.query(
            'SELECT name, address, phone, email, website, business_hours FROM store_settings WHERE store_id = $1',
            [storeId]
        );
        const storeDocs = storeSettings.rows[0];

        // Specific Product Search (Simple keyword match if implied context exists - mocked here as general context)
        // In a real flow, we'd do vector search or keyword search based on user query

        return {
            customerOrders: recentOrders,
            storeInfo: storeDocs,
            customerPhone
        };
    }

    async generateResponse(storeId: string, conversationId: string, messageContent: string, customerPhone: string, customerId?: string): Promise<string> {
        if (!process.env.API_KEY) return "AI service unavailable.";

        try {
            const context = await this.gatherCustomerContext(storeId, customerPhone, customerId);

            const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

            const systemPrompt = `
You are a helpful, friendly, and professional customer support assistant for a retail store named "${context.storeInfo?.name || 'our store'}".
You apply WhatsApp Business communication style: concise, polite, and helpful. Use emojis sparingly.

CONTEXT:
Store Info: 
- Address: ${context.storeInfo?.address || 'N/A'}
- Contact: ${context.storeInfo?.phone || 'N/A'}
- Email: ${context.storeInfo?.email || 'N/A'}
- Website: ${context.storeInfo?.website || 'N/A'}

Customer Context:
- Phone: ${context.customerPhone}
- Recent Orders: ${context.customerOrders.length > 0 ? JSON.stringify(context.customerOrders) : 'No recent orders found linked to this account.'}

User Message: "${messageContent}"

INSTRUCTIONS:
1. Answer the user's question directly.
2. If they ask about an order and you see it in Recent Orders, provide clear status.
3. If they ask about products, ask them specifically what they are looking for (unless you have product catalog access, which is not fully loaded in this context yet).
4. If the query is complex or an angry complaint, apologize and suggest they contact support at ${context.storeInfo?.phone || 'the store number'}.
5. Keep responses short (under 100 words preferred for WhatsApp).
6. Do NOT invent order details if not in the list.
`;

            const result = await model.generateContent(systemPrompt);
            return result.response.text();

        } catch (error) {
            console.error('WhatsApp AI Generation Error:', error);
            return "I'm having a little trouble connecting right now. Please try again in a moment, or contact us directly if urgent.";
        }
    }

    async handleIncomingMessage(storeId: string, from: string, messageBody: string, conversationId: string, customerId?: string) {
        // 1. Generate AI response
        const aiResponse = await this.generateResponse(storeId, conversationId, messageBody, from, customerId);

        // 2. Send response via WhatsApp Service
        try {
            await whatsAppService.sendTextMessage(storeId, from, aiResponse);

            // 3. Log the outbound AI message
            await whatsAppService.logMessage(
                conversationId,
                storeId,
                'outbound',
                'text',
                aiResponse,
                undefined, // we don't have the message ID yet until sent response (SDK differs) - handled by sender usually
                'sent',
                true
            );
        } catch (error) {
            console.error('Failed to send AI response:', error);
        }
    }
}

export default new WhatsAppAIService();
