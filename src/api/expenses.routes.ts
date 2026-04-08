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

/**
 * @openapi
 * /expenses:
 *   get:
 *     tags: [Expenses]
 *     summary: Get all expenses (admin only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of expenses
 *   post:
 *     tags: [Expenses]
 *     summary: Create a new expense
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               description: { type: string }
 *               amount: { type: number }
 *               date: { type: string, format: date }
 *               expenseAccountId: { type: string }
 *               paymentAccountId: { type: string }
 */
router.route('/')
    .get(getExpenses)
    .post(createExpense);

/**
 * @openapi
 * /expenses/{id}:
 *   get:
 *     tags: [Expenses]
 *     summary: Get expense by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   put:
 *     tags: [Expenses]
 *     summary: Update an expense
 *     security:
 *       - bearerAuth: []
 *   delete:
 *     tags: [Expenses]
 *     summary: Delete an expense
 *     security:
 *       - bearerAuth: []
 */
router.route('/:id')
    .get(getExpenseById)
    .put(updateExpense)
    .delete(deleteExpense);

export default router;
