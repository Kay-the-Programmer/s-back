import express from 'express';
import { listStores, updateStore, createNotification, listSystemNotifications, getNotificationStatus, listRevenueSummary, listSubscriptionPayments, recordSubscriptionPayment, getStoreDetails, sendStoreNotification } from '../controllers/superadmin.controller';
import { handleSuperAdminChat } from '../controllers/ai.controller';
import { protect, superAdminOnly } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /superadmin/stores:
 *   get:
 *     tags: [Super Admin]
 *     summary: List all stores in the system
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all stores
 */
router.get('/stores', protect, superAdminOnly, listStores);

/**
 * @openapi
 * /superadmin/stores/{id}:
 *   get:
 *     tags: [Super Admin]
 *     summary: Get store details by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   patch:
 *     tags: [Super Admin]
 *     summary: Update store details or status
 *     security:
 *       - bearerAuth: []
 */
router.get('/stores/:id', protect, superAdminOnly, getStoreDetails);
router.patch('/stores/:id', protect, superAdminOnly, updateStore);

/**
 * @openapi
 * /superadmin/stores/{id}/notifications:
 *   post:
 *     tags: [Super Admin]
 *     summary: Send a notification to a specific store
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/stores/:id/notifications', protect, superAdminOnly, sendStoreNotification);

/**
 * @openapi
 * /superadmin/notifications:
 *   post:
 *     tags: [Super Admin]
 *     summary: Create a system-wide notification
 *     security:
 *       - bearerAuth: []
 *   get:
 *     tags: [Super Admin]
 *     summary: Get all system notifications
 *     security:
 *       - bearerAuth: []
 */
router.post('/notifications', protect, superAdminOnly, createNotification);
router.get('/notifications', protect, superAdminOnly, listSystemNotifications);

/**
 * @openapi
 * /superadmin/notifications/{id}/status:
 *   get:
 *     tags: [Super Admin]
 *     summary: Get notification delivery status
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/notifications/:id/status', protect, superAdminOnly, getNotificationStatus);

/**
 * @openapi
 * /superadmin/revenue/summary:
 *   get:
 *     tags: [Super Admin]
 *     summary: Get subscription revenue summary
 *     security:
 *       - bearerAuth: []
 */
router.get('/revenue/summary', protect, superAdminOnly, listRevenueSummary);

/**
 * @openapi
 * /superadmin/revenue/payments:
 *   get:
 *     tags: [Super Admin]
 *     summary: List all subscription payments
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Super Admin]
 *     summary: Manually record a subscription payment
 *     security:
 *       - bearerAuth: []
 */
router.get('/revenue/payments', protect, superAdminOnly, listSubscriptionPayments);
router.post('/revenue/payments', protect, superAdminOnly, recordSubscriptionPayment);

/**
 * @openapi
 * /superadmin/ai/chat:
 *   post:
 *     tags: [Super Admin]
 *     summary: Chat with the superadmin AI assistant
 *     security:
 *       - bearerAuth: []
 */
router.post('/ai/chat', protect, superAdminOnly, handleSuperAdminChat);

export default router;
