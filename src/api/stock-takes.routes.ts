import express from 'express';
import { getActiveStockTake, startStockTake, updateStockTakeItem, cancelStockTake, finalizeStockTake } from '../controllers/stock-takes.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect, canManageInventory);

router.route('/')
    .post(startStockTake);

router.route('/active')
    .get(getActiveStockTake)
    .delete(cancelStockTake);

router.post('/active/finalize', finalizeStockTake);
router.put('/active/items/:productId', updateStockTakeItem);


export default router;