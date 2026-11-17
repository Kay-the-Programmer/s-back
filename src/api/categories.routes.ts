import express from 'express';
import { getCategories, createCategory, updateCategory, deleteCategory, reorderCategories } from '../controllers/categories.controller';
import { protect, canManageInventory, requirePermission } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /categories:
 *   get:
 *     tags: [Categories]
 *     summary: Get all product categories
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of categories
 *   post:
 *     tags: [Categories]
 *     summary: Create a new category
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               parentId: { type: string }
 *     responses:
 *       201:
 *         description: Category created
 */
router.route('/')
    .get(protect, requirePermission('inventory:read'), getCategories)
    .post(protect, canManageInventory, createCategory);

/**
 * @openapi
 * /categories/reorder:
 *   patch:
 *     tags: [Categories]
 *     summary: Save the display order of menu sections in one call
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               ids:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       200:
 *         description: Order saved
 */
// Declared before '/:id' so "reorder" is never read as a category id.
router.patch('/reorder', protect, canManageInventory, reorderCategories);

/**
 * @openapi
 * /categories/{id}:
 *   put:
 *     tags: [Categories]
 *     summary: Update a category
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   delete:
 *     tags: [Categories]
 *     summary: Delete a category
 *     security:
 *       - bearerAuth: []
 */
router.route('/:id')
    .put(protect, canManageInventory, updateCategory)
    .delete(protect, canManageInventory, deleteCategory);

export default router;