import express from 'express';
import {
    getProducts,
    getProductById,
    createProduct,
    updateProduct,
    deleteProduct,
    adjustStock,
    archiveProduct,
    lookupExternalProduct,
} from '../controllers/products.controller';
import { protect, canManageInventory, requirePermission } from '../middleware/auth.middleware';
import { importProducts } from '../controllers/product-import.controller';
import upload from '../middleware/upload.middleware';

const router = express.Router();

/**
 * @openapi
 * /products:
 *   get:
 *     tags: [Products]
 *     summary: Get all products
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of products
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 *   post:
 *     tags: [Products]
 *     summary: Create a new product
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               price: { type: number }
 *               stock: { type: number }
 *               images:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: binary
 */
router.route('/')
    .get(protect, requirePermission('inventory:read'), getProducts)
    .post(protect, canManageInventory, upload.array('images', 5), createProduct);

/**
 * @openapi
 * /products/{id}:
 *   get:
 *     tags: [Products]
 *     summary: Get product by ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   put:
 *     tags: [Products]
 *     summary: Update a product
 *   delete:
 *     tags: [Products]
 *     summary: Delete a product
 */
router.route('/:id')
    .get(protect, requirePermission('inventory:read'), getProductById)
    .put(protect, canManageInventory, upload.array('images', 5), updateProduct)
    .delete(protect, canManageInventory, deleteProduct);

router.patch('/:id/stock', protect, canManageInventory, adjustStock);
router.patch('/:id/archive', protect, canManageInventory, archiveProduct);
router.get('/external-lookup/:barcode', protect, requirePermission('inventory:read'), lookupExternalProduct);

/**
 * @openapi
 * /products/import:
 *   post:
 *     tags: [Products]
 *     summary: Bulk-import products from a parsed CSV
 *     description: >
 *       Accepts rows parsed client-side. Send `dryRun: true` to validate and get
 *       a per-row preview without writing anything; send `updateExisting: true`
 *       to refresh products matched by SKU (or name) instead of skipping them.
 *       The whole import runs in one transaction.
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               rows:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     name: { type: string }
 *                     sku: { type: string }
 *                     category: { type: string }
 *                     price: { type: number }
 *                     costPrice: { type: number }
 *                     stock: { type: number }
 *               updateExisting: { type: boolean }
 *               dryRun: { type: boolean }
 */
router.post('/import', protect, canManageInventory, importProducts);

export default router;