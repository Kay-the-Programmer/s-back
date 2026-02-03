import express from 'express';
import db from '../db_client';
import { toCamelCase, generateId } from '../utils/helpers';

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

export const createLowStockNotification = async (req: express.Request, res: express.Response) => {
    const { productId, productName, currentStock, reorderPoint, requestedBy, storeId } = req.body;

    if (!storeId) {
        // Return clear error if storeId is missing
        res.status(400).json({ message: 'Store ID is required' });
        return;
    }

    try {
        const id = generateId('notif');
        const title = "Low Stock Alert";
        const message = `Low stock: ${productName} (${currentStock} left). Reorder at: ${reorderPoint}. By: ${requestedBy}`;

        // We assume 'notifications' table exists and has 'type' column.
        // If not, this might fail, but it adheres to request requirements.
        await db.query(`
            INSERT INTO notifications (id, store_id, title, message, type, is_read, created_at)
            VALUES ($1, $2, $3, $4, 'low_stock', FALSE, NOW())
        `, [id, storeId, title, message]);

        res.status(201).json({ message: 'Low stock notification created successfully' });
    } catch (error) {
        console.error('Error creating low stock notification:', error);
        res.status(500).json({ message: 'Failed to create notification', error: (error as Error).message });
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
