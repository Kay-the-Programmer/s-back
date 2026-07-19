import { Router } from 'express';
import { verifyPayment, getBanks, handleLencoWebhook, initiatePayment, chargeMobileMoney, cancelPayment } from '../controllers/payment.controller';
import { protect } from '../middleware/auth.middleware';

const router = Router();

/**
 * @openapi
 * /payments/lenco/verify:
 *   post:
 *     tags: [Payments]
 *     summary: Verify a Lenco payment
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reference: { type: string }
 */
router.post('/lenco/verify', protect, verifyPayment);

/**
 * @openapi
 * /payments/lenco/banks:
 *   get:
 *     tags: [Payments]
 *     summary: Get list of supported banks from Lenco
 *     responses:
 *       200:
 *         description: List of banks
 */
router.get('/lenco/banks', protect, getBanks);

/**
 * @openapi
 * /payments/lenco/webhook:
 *   post:
 *     tags: [Payments]
 *     summary: Handle Lenco payment webhook
 *     description: This endpoint is called by Lenco to notify payment status changes.
 */
router.post('/lenco/webhook', handleLencoWebhook);

/**
 * @openapi
 * /payments/lenco/initiate:
 *   post:
 *     tags: [Payments]
 *     summary: Initiate a payment via Lenco
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               amount: { type: number }
 *               email: { type: string }
 *               reference: { type: string }
 */
router.post('/lenco/initiate', protect, initiatePayment);

/**
 * @openapi
 * /payments/lenco/charge-mobile-money:
 *   post:
 *     tags: [Payments]
 *     summary: Charge via mobile money through Lenco
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phone: { type: string }
 *               amount: { type: number }
 */
router.post('/lenco/charge-mobile-money', protect, chargeMobileMoney);

/**
 * @openapi
 * /payments/lenco/cancel:
 *   post:
 *     tags: [Payments]
 *     summary: Cancel a Lenco payment
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reference: { type: string }
 */
router.post('/lenco/cancel', protect, cancelPayment);

export default router;
