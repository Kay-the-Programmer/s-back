
import express from 'express';
import * as pushController from '../controllers/push.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /push/vapid-public-key:
 *   get:
 *     tags: [Push Notifications]
 *     summary: Get the VAPID public key for web push subscriptions
 *     responses:
 *       200:
 *         description: VAPID public key
 */
router.get('/vapid-public-key', pushController.getVapidPublicKey);

/**
 * @openapi
 * /push/subscribe:
 *   post:
 *     tags: [Push Notifications]
 *     summary: Subscribe a device to push notifications
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Web Push subscription object
 */
router.post('/subscribe', pushController.subscribe);

/**
 * @openapi
 * /push/unsubscribe:
 *   post:
 *     tags: [Push Notifications]
 *     summary: Unsubscribe a device from push notifications
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Web Push subscription object
 */
router.post('/unsubscribe', pushController.unsubscribe);

/**
 * @openapi
 * /push/test:
 *   post:
 *     tags: [Push Notifications]
 *     summary: Send a test push notification to the authenticated user
 *     security:
 *       - bearerAuth: []
 */
router.post('/test', protect, pushController.sendTestNotification);

export default router;
