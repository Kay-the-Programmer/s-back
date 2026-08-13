import express from 'express';
import { getDashboardData, getDailySalesWithProducts, getProductSales, getPersonalUseAdjustments } from '../controllers/reports.controller';
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
 * /reports/product-sales:
 *   get:
 *     tags: [Reports]
 *     summary: Units sold and revenue per product for a period
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: startDate
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: endDate
 *         required: true
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: channel
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string, enum: [quantity, revenue, profit, name, sku, transactions] }
 *       - in: query
 *         name: sortOrder
 *         schema: { type: string, enum: [asc, desc] }
 *     responses:
 *       200:
 *         description: Per-product units sold, revenue, cost and profit
 */
router.get('/product-sales', protect, canPerformSales, getProductSales);

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