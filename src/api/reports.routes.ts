import express from 'express';
import { getDashboardData, getDailySalesWithProducts, getPersonalUseAdjustments } from '../controllers/reports.controller';
import { protect, canManageInventory, canPerformSales } from '../middleware/auth.middleware';

const router = express.Router();

router.get('/dashboard', protect, canManageInventory, getDashboardData);
router.get('/daily-sales', protect, canPerformSales, getDailySalesWithProducts);
router.get('/personal-use', protect, canManageInventory, getPersonalUseAdjustments);

export default router;