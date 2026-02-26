import admin from 'firebase-admin';
import db from '../db_client';

export interface PushNotificationPayload {
    title: string;
    body: string;
    icon?: string;
    url?: string;
}

class PushService {
    /**
     * Send a push notification to specific users
     */
    async sendToUsers(userIds: string[], payload: PushNotificationPayload, storeId?: string) {
        if (userIds.length === 0) return;
        try {
            // 1. Persist to database notifications table for each user
            for (const userId of userIds) {
                const notifId = `notif_${Math.random().toString(36).slice(2, 9)}`;
                await db.query(
                    `INSERT INTO notifications (id, user_id, store_id, title, message, link, type, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
                    [notifId, userId, storeId || null, payload.title, payload.body, payload.url || null, 'info']
                );
            }

            // 2. Get all tokens for these users
            const result = await db.query(
                'SELECT endpoint FROM push_subscriptions WHERE user_id = ANY($1::text[])',
                [userIds]
            );

            const tokens = result.rows.map(sub => sub.endpoint).filter(Boolean);

            if (tokens.length === 0) {
                console.log(`No push tokens found for users: ${userIds.join(', ')}`);
                return;
            }

            return this.sendToTokens(tokens, payload);
        } catch (error) {
            console.error('Error in sendToUsers:', error);
        }
    }

    /**
     * Send to all users of a specific store (admins + staff)
     */
    async sendToStore(storeId: string, payload: PushNotificationPayload, roles?: string[]) {
        try {
            let userQuery = 'SELECT id FROM users WHERE current_store_id = $1';
            const params = [storeId];
            if (roles && roles.length > 0) {
                userQuery += ' AND role = ANY($2::text[])';
                params.push(roles as any);
            }
            const userRes = await db.query(userQuery, params);
            const userIds = userRes.rows.map(u => u.id);
            return this.sendToUsers(userIds, payload, storeId);
        } catch (error) {
            console.error('Error in sendToStore:', error);
        }
    }

    /**
     * Send a push notification to all subscribed users
     */
    async broadcast(payload: PushNotificationPayload) {
        try {
            const result = await db.query('SELECT endpoint FROM push_subscriptions');
            const tokens = result.rows.map(sub => sub.endpoint).filter(Boolean);

            if (tokens.length === 0) {
                console.log('No push tokens found for broadcast');
                return;
            }

            return this.sendToTokens(tokens, payload);
        } catch (error) {
            console.error('Error in broadcast:', error);
        }
    }

    /**
     * Internal: Send to raw FCM tokens
     */
    private async sendToTokens(tokens: string[], payload: PushNotificationPayload) {
        const messagePayload = {
            notification: {
                title: payload.title,
                body: payload.body,
            },
            data: {
                url: payload.url || '/',
            },
            tokens: tokens
        };

        try {
            const response = await admin.messaging().sendEachForMulticast(messagePayload);

            console.log(`FCM: Successfully sent ${response.successCount} messages; ${response.failureCount} failed.`);

            if (response.failureCount > 0) {
                // Clean up invalid tokens
                const tokensToDelete: string[] = [];
                response.responses.forEach((resp, idx) => {
                    if (!resp.success) {
                        const errorCode = resp.error?.code;
                        if (errorCode === 'messaging/invalid-registration-token' ||
                            errorCode === 'messaging/registration-token-not-registered') {
                            tokensToDelete.push(tokens[idx]);
                        }
                    }
                });

                if (tokensToDelete.length > 0) {
                    await db.query(
                        'DELETE FROM push_subscriptions WHERE endpoint = ANY($1::text[])',
                        [tokensToDelete]
                    );
                    console.log(`Cleaned up ${tokensToDelete.length} invalid FCM tokens.`);
                }
            }

            return response;
        } catch (error) {
            console.error('Error sending multicast message:', error);
            throw error;
        }
    }
}

export const pushService = new PushService();
