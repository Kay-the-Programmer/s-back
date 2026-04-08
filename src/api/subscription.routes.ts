import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller';
import { protect } from '../middleware/auth.middleware';

const router = Router();

/**
 * @openapi
 * /subscriptions/plans:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Get all available subscription plans (public)
 *     responses:
 *       200:
 *         description: List of subscription plans
 */
router.get('/plans', subscriptionController.getPlans);

/**
 * @openapi
 * /subscriptions/pay:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Initiate a subscription payment
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               planId: { type: string }
 *               storeId: { type: string }
 */
router.post('/pay', protect, subscriptionController.createPayment);

/**
 * @openapi
 * /subscriptions/verify/{reference}:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Verify a subscription payment by reference
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/verify/:reference', protect, subscriptionController.verifyPayment);

/**
 * @openapi
 * /subscriptions/cancel/{reference}:
 *   post:
 *     tags: [Subscriptions]
 *     summary: Cancel a subscription payment
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: reference
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/cancel/:reference', protect, subscriptionController.cancelPayment);

/**
 * @openapi
 * /subscriptions/history/{storeId}:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Get subscription payment history for a store
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/history/:storeId', protect, subscriptionController.getHistory);

export default router;
