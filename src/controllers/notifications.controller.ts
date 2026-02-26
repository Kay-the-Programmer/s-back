import express from 'express';
import db from '../db_client';
import { toCamelCase, generateId } from '../utils/helpers';

export const getStoreNotifications = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    const userId = req.user?.id;

    if (!userId) {
        return res.status(401).json({ message: 'User not authenticated' });
    }

    try {
        const result = await db.query(`
            SELECT * FROM notifications 
            WHERE 
                user_id = $1 
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
