import express from 'express';
import {
    getSuppliers, createSupplier, updateSupplier, deleteSupplier, getSupplierById
} from '../controllers/suppliers.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect, canManageInventory);

/**
 * @openapi
 * /suppliers:
 *   get:
 *     tags: [Suppliers]
 *     summary: Get all suppliers
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of suppliers
 *   post:
 *     tags: [Suppliers]
 *     summary: Create a new supplier
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
 *               contactPerson: { type: string }
 *               phone: { type: string }
 *               email: { type: string }
 *     responses:
 *       201:
 *         description: Supplier created
 */
router.route('/')
    .get(getSuppliers)
    .post(createSupplier);

/**
 * @openapi
 * /suppliers/{id}:
 *   get:
 *     tags: [Suppliers]
 *     summary: Get supplier by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   put:
 *     tags: [Suppliers]
 *     summary: Update a supplier
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Suppliers]
 *     summary: Delete a supplier
 *     security:
 *       - bearerAuth: []
 */
router.route('/:id')
    .get(getSupplierById)
    .put(updateSupplier)
    .delete(deleteSupplier);

export default router;