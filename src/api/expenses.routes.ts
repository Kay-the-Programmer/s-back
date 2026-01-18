import express from 'express';
import {
    getExpenses,
    getExpenseById,
    createExpense,
    updateExpense,
    deleteExpense
} from '../controllers/expenses.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();
router.use(protect, adminOnly);

router.route('/')
    .get(getExpenses)
    .post(createExpense);

router.route('/:id')
    .get(getExpenseById)
    .put(updateExpense)
    .delete(deleteExpense);

export default router;
