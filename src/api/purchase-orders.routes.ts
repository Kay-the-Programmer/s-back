import express from 'express';
import { getPurchaseOrders, createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder, receiveItems, getReorderSuggestions } from '../controllers/purchase-orders.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';
import { requireModule } from '../middleware/entitlements.middleware';
import { MODULES } from '../services/entitlements.service';

const router = express.Router();

router.use(protect, canManageInventory);

/**
 * @openapi
 * /purchase-orders/reorder-suggestions:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: Draft purchase orders for everything at or below its reorder point
 *     description: >
 *       Premium (AUTO_REORDER add-on). Raising a purchase order by hand stays
 *       free; only the automatic suggestion is paid for, which is why the gate
 *       sits here rather than on POST /purchase-orders.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: One draft per supplier, richest first
 *       402:
 *         description: The store does not have the Auto Reorder add-on
 */
router.get('/reorder-suggestions', requireModule(MODULES.AUTO_REORDER), getReorderSuggestions);

/**
 * @openapi
 * /purchase-orders:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: Get all purchase orders
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of purchase orders
 *   post:
 *     tags: [Purchase Orders]
 *     summary: Create a new purchase order
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               supplierId: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     productId: { type: string }
 *                     quantity: { type: number }
 *                     costPrice: { type: number }
 */
router.route('/')
    .get(getPurchaseOrders)
    .post(createPurchaseOrder);

/**
 * @openapi
 * /purchase-orders/{id}:
 *   put:
 *     tags: [Purchase Orders]
 *     summary: Update a purchase order
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   delete:
 *     tags: [Purchase Orders]
 *     summary: Delete a purchase order
 *     security:
 *       - bearerAuth: []
 */
router.route('/:id')
    .put(updatePurchaseOrder)
    .delete(deletePurchaseOrder);

/**
 * @openapi
 * /purchase-orders/{id}/receive:
 *   post:
 *     tags: [Purchase Orders]
 *     summary: Receive items for a purchase order
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/:id/receive', receiveItems);

export default router;