import express from 'express';
import db from '../db_client';
import { pushService } from '../services/push.service';

console.log('--- Push Notification Initialization ---');
console.log('✅ FCM Push notifications ready');

function genId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
}

export const getVapidPublicKey = (req: express.Request, res: express.Response) => {
    res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY || '' });
};

export const subscribe = async (req: express.Request, res: express.Response) => {
    const { subscription, userId } = req.body;

    if (!subscription) {
        return res.status(400).json({ message: 'Invalid subscription (FCM token required)' });
    }

    try {
        const fcmToken = typeof subscription === 'string' ? subscription : subscription.endpoint;

        await db.query(`
            INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (endpoint) DO UPDATE SET
                user_id = EXCLUDED.user_id
        `, [genId('psub'), userId || null, fcmToken, null, null]);

        res.status(201).json({ message: 'Subscribed successfully' });
    } catch (error) {
        console.error('Error subscribing to push:', error);
        res.status(500).json({ message: 'Failed to subscribe' });
    }
};

export const unsubscribe = async (req: express.Request, res: express.Response) => {
    const { endpoint } = req.body;

    if (!endpoint) {
        return res.status(400).json({ message: 'Endpoint (FCM token) required' });
    }

    try {
        await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
        res.status(200).json({ message: 'Unsubscribed successfully' });
    } catch (error) {
        console.error('Error unsubscribing from push:', error);
        res.status(500).json({ message: 'Failed to unsubscribe' });
    }
};

export const sendTestNotification = async (req: express.Request, res: express.Response) => {
    const { userId, title, message } = req.body;

    try {
        if (userId) {
            await pushService.sendToUsers([userId], {
                title: title || 'Test Notification',
                body: message || 'This is a test notification from SalePilot.',
                url: '/'
            });
        } else {
            await pushService.broadcast({
                title: title || 'Test Broadcast',
                body: message || 'This is a test broadcast to everyone.',
                url: '/'
            });
        }

        res.status(200).json({ message: 'Test notification process triggered' });
    } catch (error) {
        console.error('Error sending test notification:', error);
        res.status(500).json({ message: 'Failed to send test notification' });
    }
};
