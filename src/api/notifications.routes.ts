import express from 'express';
import { getStoreNotifications, markAsRead } from '../controllers/notifications.controller';

const router = express.Router();

/**
 * @openapi
 * /notifications/stores/{storeId}:
 *   get:
 *     tags: [Notifications]
 *     summary: Get notifications for a specific store
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of store notifications
 */
router.get('/stores/:storeId', getStoreNotifications);

/**
 * @openapi
 * /notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark a notification as read
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Notification marked as read
 */
router.patch('/:id/read', markAsRead);

export default router;
