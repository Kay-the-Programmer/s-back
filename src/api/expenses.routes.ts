import express from 'express';
import {
    getExpenses,
    getExpenseById,
    getExpenseAccountOptions,
    createExpense,
    updateExpense,
    deleteExpense
} from '../controllers/expenses.controller';
import { protect } from '../middleware/auth.middleware';
import { requirePermission, requireAnyPermission } from '../auth/rbac';

const router = express.Router();
router.use(protect);

/**
 * Two levels of access:
 *   - `expenses:manage` (admin)  — the whole store's expenses, incl. edit/delete.
 *   - `expenses:record` (staff)  — record an expense and see the ones you
 *     recorded. The controller narrows every read to `created_by` for callers
 *     who don't hold `expenses:manage`, so the route guard alone is never what
 *     keeps one cashier's spending out of another's list.
 */
const canRecord = requireAnyPermission('expenses:manage', 'expenses:record');
const canManage = requirePermission('expenses:manage');

/**
 * @openapi
 * /expenses/accounts:
 *   get:
 *     tags: [Expenses]
 *     summary: Accounts selectable when recording an expense
 *     description: >
 *       The expense categories and the cash/bank accounts an expense can be
 *       paid from. Available to anyone who may record an expense, so the
 *       recording form doesn't require access to the chart of accounts.
 *     security:
 *       - bearerAuth: []
 */
router.get('/accounts', canRecord, getExpenseAccountOptions);

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
    .get(canRecord, getExpenses)
    .post(canRecord, createExpense);

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
    .get(canRecord, getExpenseById)
    // Editing or deleting rewrites the journal — admin only.
    .put(canManage, updateExpense)
    .delete(canManage, deleteExpense);

export default router;