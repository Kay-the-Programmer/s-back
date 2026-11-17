/**
 * Open bills (restaurants, bars, cafes).
 *
 * Gated on permissions, NOT on the store's business mode. A venue that toggles
 * itself back to a retail till mid-service must still be able to settle the
 * bills already on the floor — a 403 there would strand real money.
 */
import express from 'express';
import {
    listTabs,
    getTab,
    createTab,
    addTabItems,
    updateTabItem,
    removeTabItem,
    claimTab,
    releaseTab,
    closeTab,
    voidTab,
} from '../controllers/hospitality.controller';
import { protect } from '../middleware/auth.middleware';
import { requirePermission } from '../auth/rbac';

const router = express.Router();

/**
 * @openapi
 * /hospitality/tabs:
 *   get:
 *     tags: [Hospitality]
 *     summary: List open bills (status=live|open|settling|closed|void|all)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bills with their lines and running subtotal
 *   post:
 *     tags: [Hospitality]
 *     summary: Open a bill, optionally with its first round
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               label: { type: string, description: "Table number or customer name" }
 *               customerId: { type: string }
 *               note: { type: string }
 *               items:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     productId: { type: string }
 *                     quantity: { type: number }
 *     responses:
 *       201:
 *         description: Bill opened
 *       409:
 *         description: A bill with that name is already open
 */
router.route('/tabs')
    .get(protect, requirePermission('tabs:operate'), listTabs)
    .post(protect, requirePermission('tabs:operate'), createTab);

router.get('/tabs/:id', protect, requirePermission('tabs:operate'), getTab);

/**
 * @openapi
 * /hospitality/tabs/{id}/items:
 *   post:
 *     tags: [Hospitality]
 *     summary: Add a round to an open bill
 *     security:
 *       - bearerAuth: []
 */
router.post('/tabs/:id/items', protect, requirePermission('tabs:operate'), addTabItems);
router.patch('/tabs/:id/items/:itemId', protect, requirePermission('tabs:operate'), updateTabItem);
router.delete('/tabs/:id/items/:itemId', protect, requirePermission('tabs:operate'), removeTabItem);

/**
 * @openapi
 * /hospitality/tabs/{id}/claim:
 *   post:
 *     tags: [Hospitality]
 *     summary: Claim a bill before posting its sale, so no other till can charge it
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       409:
 *         description: Another till holds it, or it is already settled
 */
router.post('/tabs/:id/claim', protect, requirePermission('tabs:operate'), claimTab);
router.post('/tabs/:id/release', protect, requirePermission('tabs:operate'), releaseTab);

/**
 * @openapi
 * /hospitality/tabs/{id}/close:
 *   post:
 *     tags: [Hospitality]
 *     summary: Close a bill against the sale that settled it
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               saleId: { type: string }
 */
router.post('/tabs/:id/close', protect, requirePermission('tabs:operate'), closeTab);

// Writing off an unpaid bill with items on it is a manager's call, not a
// waiter's — it is revenue the shop has decided not to collect.
router.post('/tabs/:id/void', protect, requirePermission('tabs:void'), voidTab);

export default router;
