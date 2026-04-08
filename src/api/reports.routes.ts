import express from 'express';
import { getDashboardData, getDailySalesWithProducts, getPersonalUseAdjustments } from '../controllers/reports.controller';
import { protect, canManageInventory, canPerformSales } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /reports/dashboard:
 *   get:
 *     tags: [Reports]
 *     summary: Get dashboard analytics data
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Dashboard data including sales, revenue, and inventory stats
 */
router.get('/dashboard', protect, canManageInventory, getDashboardData);

/**
 * @openapi
 * /reports/daily-sales:
 *   get:
 *     tags: [Reports]
 *     summary: Get daily sales report with product details
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: date
 *         schema:
 *           type: string
 *           format: date
 *     responses:
 *       200:
 *         description: Daily sales data
 */
router.get('/daily-sales', protect, canPerformSales, getDailySalesWithProducts);

/**
 * @openapi
 * /reports/personal-use:
 *   get:
 *     tags: [Reports]
 *     summary: Get personal use / stock adjustment report
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Personal use adjustment records
 */
router.get('/personal-use', protect, canManageInventory, getPersonalUseAdjustments);

export default router;