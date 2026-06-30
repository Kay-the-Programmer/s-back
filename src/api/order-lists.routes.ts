import express from 'express';
import { getOrderLists, upsertOrderList, deleteOrderList } from '../controllers/order-lists.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';

const router = express.Router();

// Order lists are a procurement concern — gate behind the same permission as
// purchase orders.
router.use(protect, canManageInventory);

/**
 * @openapi
 * /order-lists:
 *   get:
 *     tags: [Order Lists]
 *     summary: Get all quick order lists for the current store
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of order lists
 *   post:
 *     tags: [Order Lists]
 *     summary: Create or update an order list (idempotent upsert by id)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               id: { type: string }
 *               title: { type: string }
 *               createdAt: { type: number }
 *               importedAt: { type: number }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 */
router.route('/')
    .get(getOrderLists)
    .post(upsertOrderList);

/**
 * @openapi
 * /order-lists/{id}:
 *   delete:
 *     tags: [Order Lists]
 *     summary: Delete an order list
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.delete('/:id', deleteOrderList);

export default router;
