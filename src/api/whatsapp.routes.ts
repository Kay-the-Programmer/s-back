
import express from 'express';
import { verifyWebhook, handleWebhook, getConfiguration, updateConfiguration, getStatus, getConversations, getMessages, getMessageHistory, sendManualMessage, getSupportContact, updateSupportContact } from '../controllers/whatsapp.controller';
import { protect, requirePermission } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /whatsapp/webhook:
 *   get:
 *     tags: [WhatsApp]
 *     summary: Verify WhatsApp webhook (Meta challenge)
 *     parameters:
 *       - in: query
 *         name: hub.mode
 *         schema:
 *           type: string
 *       - in: query
 *         name: hub.verify_token
 *         schema:
 *           type: string
 *       - in: query
 *         name: hub.challenge
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Challenge token echoed back
 *   post:
 *     tags: [WhatsApp]
 *     summary: Handle incoming WhatsApp webhook events
 *     description: Receives messages and status updates from Meta.
 */
router.get('/webhook', verifyWebhook);
router.post('/webhook', handleWebhook);

// All routes below require authentication
router.use(protect);

/**
 * @openapi
 * /whatsapp/config:
 *   get:
 *     tags: [WhatsApp]
 *     summary: Get WhatsApp configuration
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: WhatsApp config object
 *   put:
 *     tags: [WhatsApp]
 *     summary: Update WhatsApp configuration
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               phoneNumberId: { type: string }
 *               accessToken: { type: string }
 */
router.get('/config', requirePermission('messaging:read'), getConfiguration);
router.put('/config', requirePermission('messaging:manage'), updateConfiguration);

/**
 * @openapi
 * /whatsapp/status:
 *   get:
 *     tags: [WhatsApp]
 *     summary: WhatsApp connection status for the current store (no secrets)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: "{ configured, enabled, entitled, displayPhoneNumber }"
 */
router.get('/status', requirePermission('messaging:read'), getStatus);

/**
 * @openapi
 * /whatsapp/messages:
 *   get:
 *     tags: [WhatsApp]
 *     summary: WhatsApp message history for the store (optionally by customer)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: customerId
 *         schema: { type: string }
 */
router.get('/messages', requirePermission('messaging:read'), getMessageHistory);

/**
 * @openapi
 * /whatsapp/conversations:
 *   get:
 *     tags: [WhatsApp]
 *     summary: Get all WhatsApp conversations
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of conversations
 */
router.get('/conversations', requirePermission('messaging:read'), getConversations);

/**
 * @openapi
 * /whatsapp/conversations/{id}/messages:
 *   get:
 *     tags: [WhatsApp]
 *     summary: Get messages for a specific conversation
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/conversations/:id/messages', requirePermission('messaging:read'), getMessages);

/**
 * @openapi
 * /whatsapp/send:
 *   post:
 *     tags: [WhatsApp]
 *     summary: Manually send a WhatsApp message
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               to: { type: string }
 *               message: { type: string }
 */
router.post('/send', requirePermission('messaging:send'), sendManualMessage);

/**
 * @openapi
 * /whatsapp/support-contact:
 *   get:
 *     tags: [WhatsApp]
 *     summary: Get the WhatsApp support contact
 *     security:
 *       - bearerAuth: []
 *   put:
 *     tags: [WhatsApp]
 *     summary: Update the WhatsApp support contact
 *     security:
 *       - bearerAuth: []
 */
router.get('/support-contact', requirePermission('messaging:read'), getSupportContact);
router.put('/support-contact', requirePermission('messaging:manage'), updateSupportContact);

export default router;
