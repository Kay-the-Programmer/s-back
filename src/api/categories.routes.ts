import express from 'express';
import { getCategories, createCategory, updateCategory, deleteCategory } from '../controllers/categories.controller';
import { protect, canManageInventory } from '../middleware/auth.middleware';

const router = express.Router();

router.route('/')
    .get(protect, getCategories)
    .post(protect, canManageInventory, createCategory);

router.route('/:id')
    .put(protect, canManageInventory, updateCategory)
    .delete(protect, canManageInventory, deleteCategory);

export default router;