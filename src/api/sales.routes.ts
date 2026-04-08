import express from 'express';
import { getSales, createSale, recordPayment, updateFulfillmentStatus } from '../controllers/sales.controller';
import { protect, canPerformSales } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /sales:
 *   get:
 *     tags: [Sales]
 *     summary: Get all sales transactions
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of sales
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Sale'
 *   post:
 *     tags: [Sales]
 *     summary: Create a new sale
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               cart:
 *                 type: array
 *                 items:
 *                   type: object
 *               customerId: { type: string }
 *               paymentMethod: { type: string }
 */
router.route('/')
    .get(protect, getSales)
    .post(protect, canPerformSales, createSale);

router.route('/:id/payments')
    .post(protect, canPerformSales, recordPayment);

router.route('/:id/fulfillment')
    .put(protect, canPerformSales, updateFulfillmentStatus);

export default router;