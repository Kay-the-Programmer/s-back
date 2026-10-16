import express from 'express';
import {
    getLoyaltyProgram, saveLoyaltyProgram,
    getRedemptions, createRedemption,
    getMessageTemplates, createMessageTemplate, updateMessageTemplate, deleteMessageTemplate,
    sendCustomerEmail, getCustomerOutreach,
} from '../controllers/crm.controller';
import { protect, requirePermission } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /crm/loyalty/program:
 *   get:
 *     tags: [CRM]
 *     summary: The store's loyalty program configuration (defaults when unset)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Loyalty configuration }
 *   put:
 *     tags: [CRM]
 *     summary: Save the store's loyalty program configuration
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Saved configuration }
 */
router.route('/loyalty/program')
    .get(protect, requirePermission('customers:read'), getLoyaltyProgram)
    .put(protect, requirePermission('customers:manage'), saveLoyaltyProgram);

/**
 * @openapi
 * /crm/loyalty/redemptions:
 *   get:
 *     tags: [CRM]
 *     summary: Redemption ledger for the store (optionally one customer)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: customerId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Redemptions, newest first }
 *   post:
 *     tags: [CRM]
 *     summary: Redeem a customer's points for store credit (atomic)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [customerId]
 *             properties:
 *               customerId: { type: string }
 *     responses:
 *       201: { description: Redemption recorded and store credit granted }
 *       409: { description: Program paused or not enough points }
 */
router.route('/loyalty/redemptions')
    .get(protect, requirePermission('customers:read'), getRedemptions)
    .post(protect, requirePermission('customers:manage'), createRedemption);

/**
 * @openapi
 * /crm/templates:
 *   get:
 *     tags: [CRM]
 *     summary: Reusable message templates for the store
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Templates }
 *   post:
 *     tags: [CRM]
 *     summary: Create a message template
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       201: { description: Created }
 */
router.route('/templates')
    .get(protect, requirePermission('messaging:read'), getMessageTemplates)
    .post(protect, requirePermission('messaging:manage'), createMessageTemplate);

/**
 * @openapi
 * /crm/templates/{id}:
 *   put:
 *     tags: [CRM]
 *     summary: Update a message template
 *     security: [{ bearerAuth: [] }]
 *   delete:
 *     tags: [CRM]
 *     summary: Delete a message template
 *     security: [{ bearerAuth: [] }]
 */
router.route('/templates/:id')
    .put(protect, requirePermission('messaging:manage'), updateMessageTemplate)
    .delete(protect, requirePermission('messaging:manage'), deleteMessageTemplate);

/**
 * @openapi
 * /crm/email:
 *   post:
 *     tags: [CRM]
 *     summary: Email a customer from the CRM
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [message]
 *             properties:
 *               customerId: { type: string }
 *               subject: { type: string }
 *               message: { type: string }
 *     responses:
 *       200: { description: Sent }
 *       400: { description: No valid address or empty message }
 *       502: { description: The transport rejected the email }
 */
router.post('/email', protect, requirePermission('messaging:send'), sendCustomerEmail);

/**
 * @openapi
 * /crm/outreach:
 *   get:
 *     tags: [CRM]
 *     summary: Email + SMS + WhatsApp outreach timeline for a customer
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: customerId
 *         schema: { type: string }
 *     responses:
 *       200: { description: Outreach entries, newest first }
 */
router.get('/outreach', protect, requirePermission('messaging:read'), getCustomerOutreach);

export default router;
