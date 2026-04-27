import express from 'express';
import { getStoreNotifications, markAsRead } from '../controllers/notifications.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /notifications/stores/{storeId}:
 *   get:
 *     tags: [Notifications]
 *     summary: Get notifications for a specific store
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of store notifications
 *       401:
 *         description: Unauthorized
 */
router.get('/stores/:storeId', protect, getStoreNotifications);

/**
 * @openapi
 * /notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark a notification as read
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Notification marked as read
 *       401:
 *         description: Unauthorized
 */
router.patch('/:id/read', protect, markAsRead);

export default router;
