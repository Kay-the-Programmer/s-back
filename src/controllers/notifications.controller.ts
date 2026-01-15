import express from 'express';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';

export const getStoreNotifications = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    try {
        const result = await db.query(`
            SELECT * FROM notifications 
            WHERE store_id = $1 OR store_id IS NULL
            ORDER BY created_at DESC
        `, [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching notifications:', error);
        res.status(500).json({ message: 'Failed to fetch notifications', error: (error as Error).message });
    }
};

export const markAsRead = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        await db.query('UPDATE notifications SET is_read = TRUE WHERE id = $1', [id]);
        res.status(200).json({ message: 'Notification marked as read' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update notification' });
    }
};
