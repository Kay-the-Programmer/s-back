
import express from 'express';
import db from '../db_client';
import webpush from 'web-push';

console.log('--- Push Notification Initialization ---');
console.log('VAPID_EMAIL:', process.env.VAPID_EMAIL);
console.log('VAPID_PUBLIC_KEY length:', process.env.VAPID_PUBLIC_KEY?.length || 0);
console.log('VAPID_PRIVATE_KEY is set:', !!process.env.VAPID_PRIVATE_KEY);

if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('❌ Push notifications disabled: Missing VAPID_PUBLIC_KEY or VAPID_PRIVATE_KEY in environment');
} else {
    try {
        // Setup VAPID keys
        let vapidEmail = process.env.VAPID_EMAIL || 'admin@sale-pilot.com';
        if (vapidEmail && !vapidEmail.startsWith('mailto:') && vapidEmail.includes('@')) {
            vapidEmail = `mailto:${vapidEmail}`;
        }

        webpush.setVapidDetails(
            vapidEmail,
            process.env.VAPID_PUBLIC_KEY,
            process.env.VAPID_PRIVATE_KEY
        );
        console.log('✅ Push notifications initialized');
    } catch (err) {
        console.error('❌ Failed to set VAPID details:', err);
    }
}

function genId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
}

export const getVapidPublicKey = (req: express.Request, res: express.Response) => {
    res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY });
};

export const subscribe = async (req: express.Request, res: express.Response) => {
    const { subscription, userId } = req.body;

    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ message: 'Invalid subscription' });
    }

    try {
        const { endpoint, keys } = subscription;
        const { p256dh, auth } = keys;

        // Save to database
        await db.query(`
            INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (endpoint) DO UPDATE SET
                user_id = EXCLUDED.user_id,
                p256dh = EXCLUDED.p256dh,
                auth = EXCLUDED.auth
        `, [genId('psub'), userId || null, endpoint, p256dh, auth]);

        res.status(201).json({ message: 'Subscribed successfully' });
    } catch (error) {
        console.error('Error subscribing to push:', error);
        res.status(500).json({ message: 'Failed to subscribe' });
    }
};

export const unsubscribe = async (req: express.Request, res: express.Response) => {
    const { endpoint } = req.body;

    if (!endpoint) {
        return res.status(400).json({ message: 'Endpoint required' });
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
        const result = await db.query('SELECT * FROM push_subscriptions WHERE user_id = $1 OR ($1 IS NULL AND user_id IS NULL)', [userId || null]);

        const notifications = result.rows.map(sub => {
            const pushSubscription = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth
                }
            };

            return webpush.sendNotification(pushSubscription, JSON.stringify({
                title: title || 'Test Notification',
                body: message || 'This is a test notification from SalePilot.',
                icon: '/images/salepilot.png',
                data: {
                    url: '/'
                }
            }));
        });

        await Promise.all(notifications);
        res.status(200).json({ message: 'Test notification sent' });
    } catch (error) {
        console.error('Error sending test notification:', error);
        res.status(500).json({ message: 'Failed to send test notification' });
    }
};
