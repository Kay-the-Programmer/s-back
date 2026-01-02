import express from 'express';
import {
    getProducts,
    getProductById,
    createProduct,
    updateProduct,
    deleteProduct,
    adjustStock,
    archiveProduct,
} from '../controllers/products.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';
import upload from '../middleware/upload.middleware';

const router = express.Router();

router.route('/')
    .get(protect, getProducts)
    .post(protect, canManageInventory, upload.array('images', 5), createProduct);

router.route('/:id')
    .get(protect, getProductById)
    .put(protect, canManageInventory, upload.array('images', 5), updateProduct)
    .delete(protect, canManageInventory, deleteProduct);

router.patch('/:id/stock', protect, canManageInventory, adjustStock);
router.patch('/:id/archive', protect, canManageInventory, archiveProduct);

export default router;