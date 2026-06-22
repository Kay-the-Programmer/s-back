import express from 'express';
import { sendSms, getSmsHistory, getSmsConfig } from '../controllers/sms.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /sms/config:
 *   get:
 *     tags: [SMS]
 *     summary: Whether SMS sending is configured (no secrets returned)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200: { description: SMS config status }
 */
router.get('/config', protect, getSmsConfig);

/**
 * @openapi
 * /sms/send:
 *   post:
 *     tags: [SMS]
 *     summary: Send an SMS via Africa's Talking
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [to, message]
 *             properties:
 *               to: { type: string, description: Recipient phone number }
 *               message: { type: string }
 *               customerId: { type: string, description: Optional CRM customer id }
 *     responses:
 *       200: { description: SMS sent }
 *       400: { description: Validation error }
 *       503: { description: SMS not configured }
 */
router.post('/send', protect, sendSms);

/**
 * @openapi
 * /sms:
 *   get:
 *     tags: [SMS]
 *     summary: SMS history for the current store
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: customerId
 *         schema: { type: string }
 *     responses:
 *       200: { description: List of sent messages }
 */
router.get('/', protect, getSmsHistory);

export default router;
