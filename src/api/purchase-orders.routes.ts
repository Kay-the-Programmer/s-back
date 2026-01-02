import express from 'express';
import { getPurchaseOrders, createPurchaseOrder, updatePurchaseOrder, deletePurchaseOrder, receiveItems } from '../controllers/purchase-orders.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect, canManageInventory);

router.route('/')
    .get(getPurchaseOrders)
    .post(createPurchaseOrder);

router.route('/:id')
    .put(updatePurchaseOrder)
    .delete(deletePurchaseOrder);

router.post('/:id/receive', receiveItems);

export default router;