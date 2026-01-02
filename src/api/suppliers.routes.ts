import express from 'express';
import { getSuppliers, createSupplier, updateSupplier, deleteSupplier, getSupplierById } from '../controllers/suppliers.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect, canManageInventory);

router.route('/')
    .get(getSuppliers)
    .post(createSupplier);

router.route('/:id')
    .get(getSupplierById)
    .put(updateSupplier)
    .delete(deleteSupplier);

export default router;