import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller';
import { protect, requirePermission } from '../middleware/auth.middleware';

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
 * /subscriptions/page-modules:
 *   get:
 *     tags: [Subscriptions]
 *     summary: Page-key to add-on-module map for client-side page gating (public)
 *     responses:
 *       200: { description: Map of page key to module id }
 */
router.get('/page-modules', subscriptionController.getPageModules);

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
router.post('/pay', protect, requirePermission('billing:manage'), subscriptionController.createPayment);

/**
 * @openapi
 * /subscriptions/auto-renew:
 *   get: { tags: [Subscriptions], summary: Whether the current store's plan auto-renews, security: [{ bearerAuth: [] }] }
 *   patch: { tags: [Subscriptions], summary: Toggle plan auto-renew, security: [{ bearerAuth: [] }] }
 */
router.get('/auto-renew', protect, requirePermission('billing:manage'), subscriptionController.getPlanAutoRenew);
router.patch('/auto-renew', protect, requirePermission('billing:manage'), subscriptionController.updatePlanAutoRenew);

/*
 * `/addons`, `/addons/pay` and `/addons/:moduleId/auto-renew` lived here.
 * Nothing is sold per feature any more — the three tiers include every
 * feature and differ on capacity — so the catalogue these served was empty
 * and the charge endpoint refused every request it got. A subscription is the
 * only thing to buy, and `/pay` above buys it.
 */

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
router.get('/verify/:reference', protect, requirePermission('billing:manage'), subscriptionController.verifyPayment);

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
router.post('/cancel/:reference', protect, requirePermission('billing:manage'), subscriptionController.cancelPayment);

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
router.get('/history/:storeId', protect, requirePermission('billing:manage'), subscriptionController.getHistory);

export default router;
