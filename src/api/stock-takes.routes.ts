import express from 'express';
import { getActiveStockTake, startStockTake, updateStockTakeItem, cancelStockTake, finalizeStockTake } from '../controllers/stock-takes.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect, canManageInventory);

/**
 * @openapi
 * /stock-takes:
 *   post:
 *     tags: [Stock Takes]
 *     summary: Start a new stock take session
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Stock take session started
 */
router.route('/')
    .post(startStockTake);

/**
 * @openapi
 * /stock-takes/active:
 *   get:
 *     tags: [Stock Takes]
 *     summary: Get the current active stock take session
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Active stock take session
 *   delete:
 *     tags: [Stock Takes]
 *     summary: Cancel the active stock take session
 *     security:
 *       - bearerAuth: []
 */
router.route('/active')
    .get(getActiveStockTake)
    .delete(cancelStockTake);

/**
 * @openapi
 * /stock-takes/active/finalize:
 *   post:
 *     tags: [Stock Takes]
 *     summary: Finalize the active stock take session
 *     security:
 *       - bearerAuth: []
 */
router.post('/active/finalize', finalizeStockTake);

/**
 * @openapi
 * /stock-takes/active/items/{productId}:
 *   put:
 *     tags: [Stock Takes]
 *     summary: Update the counted quantity for a product in the active stock take
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: string
 */
router.put('/active/items/:productId', updateStockTakeItem);

export default router;