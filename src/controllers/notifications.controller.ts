import express from 'express';
import db from '../db_client';
import { toCamelCase, generateId } from '../utils/helpers';

export const getStoreNotifications = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    const userId = req.user?.id;
    const currentStoreId = req.user?.currentStoreId;

    console.log(`[notifications] Fetching for storeId: ${storeId} | userId: ${userId} | currentStoreId: ${currentStoreId}`);

    if (!userId) {
        console.log('[notifications] 401: No userId');
        return res.status(401).json({ 
            message: 'User not authenticated',
            code: 'USER_NOT_FOUND_IN_REQUEST'
        });
    }

    // Multi-tenant isolation: user must be in the store they are requesting or be a superadmin
    if (req.user?.role !== 'superadmin' && currentStoreId !== storeId) {
        console.log(`[notifications] 403: Store mismatch. Requested: ${storeId}, User's: ${currentStoreId}`);
        return res.status(403).json({ message: 'Forbidden: Access to this store notifications is denied' });
    }

    try {
        // Fetch notifications:
        // 1. Specifically for this user (optionally scoped to this store or global)
        // 2. Broadcast to this specific store
        // 3. System-wide broadcasts
        const result = await db.query(`
            SELECT * FROM notifications 
            WHERE 
                (user_id = $1 AND (store_id = $2 OR store_id IS NULL))
                OR (store_id = $2 AND user_id IS NULL)
                OR (store_id IS NULL AND user_id IS NULL)
            ORDER BY created_at DESC
        `, [userId, storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ message: 'Failed to fetch notifications', error: (error as Error).message });
    }
};

// createLowStockNotification is no longer used directly as alerts are handled in products/sales controllers via pushService.sendToStore

export const markAsRead = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        await db.query('UPDATE notifications SET is_read = TRUE WHERE id = $1', [id]);
        res.status(200).json({ message: 'Notification marked as read' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update notification' });
    }
};
