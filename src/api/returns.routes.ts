import express from 'express';
import { getReturns, createReturn, setExchangeCreditApplied } from '../controllers/returns.controller';
import { protect, canPerformSales } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect, canPerformSales);

/**
 * @openapi
 * /returns:
 *   get:
 *     tags: [Returns]
 *     summary: Get all return records
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of returns
 *   post:
 *     tags: [Returns]
 *     summary: Create a new return
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               originalSaleId: { type: string }
 *               returnedItems:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     productId: { type: string }
 *                     quantity: { type: number }
 *                     reason: { type: string }
 *                     addToStock: { type: boolean }
 *               refundMethod: { type: string }
 */
router.route('/')
    .get(getReturns)
    .post(createReturn);

/**
 * @openapi
 * /returns/{id}/exchange-credit:
 *   patch:
 *     tags: [Returns]
 *     summary: Record how much of a refund was taken in replacement goods
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The updated return
 */
router.patch('/:id/exchange-credit', setExchangeCreditApplied);

export default router;