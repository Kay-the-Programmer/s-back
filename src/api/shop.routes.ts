import express from 'express';
import { getShopInfo, getShopProducts, getShopProductById, getShopCategories, createShopOrder, getPublicStores, getGlobalProducts, getShopOrderStatus } from '../controllers/shop.controller';
import { optionalProtect } from '../middleware/auth.middleware';

const router = express.Router();

// Public shop routes - No authentication required

/**
 * @openapi
 * /shop/stores:
 *   get:
 *     tags: [Shop]
 *     summary: Get all public stores
 *     responses:
 *       200:
 *         description: List of public stores
 */
router.get('/stores', getPublicStores);

/**
 * @openapi
 * /shop/global-products:
 *   get:
 *     tags: [Shop]
 *     summary: Get all publicly listed products across all stores
 *     responses:
 *       200:
 *         description: List of global products
 */
router.get('/global-products', getGlobalProducts);

/**
 * @openapi
 * /shop/{storeId}/info:
 *   get:
 *     tags: [Shop]
 *     summary: Get a specific store's public info
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:storeId/info', getShopInfo);

/**
 * @openapi
 * /shop/{storeId}/categories:
 *   get:
 *     tags: [Shop]
 *     summary: Get a store's public categories
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:storeId/categories', getShopCategories);

/**
 * @openapi
 * /shop/{storeId}/products:
 *   get:
 *     tags: [Shop]
 *     summary: Get a store's public products
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:storeId/products', getShopProducts);

/**
 * @openapi
 * /shop/{storeId}/products/{productId}:
 *   get:
 *     tags: [Shop]
 *     summary: Get a single public product by ID
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: productId
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:storeId/products/:productId', getShopProductById);

/**
 * @openapi
 * /shop/{storeId}/orders:
 *   post:
 *     tags: [Shop]
 *     summary: Place an order at a public store
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               items:
 *                 type: array
 *               customerDetails:
 *                 type: object
 */
// optionalProtect: a signed-in customer's identity comes from their token
// (never the request body); guests order anonymously.
router.post('/:storeId/orders', optionalProtect, createShopOrder);

/**
 * @openapi
 * /shop/{storeId}/orders/{orderId}:
 *   get:
 *     tags: [Shop]
 *     summary: Public order-status lookup (requires matching checkout email or phone)
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: orderId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: email
 *         schema:
 *           type: string
 *       - in: query
 *         name: phone
 *         schema:
 *           type: string
 */
router.get('/:storeId/orders/:orderId', getShopOrderStatus);

export default router;
