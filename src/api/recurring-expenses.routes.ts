import express from 'express';
import { protect } from '../middleware/auth.middleware';
import * as recurringExpensesController from '../controllers/recurring-expenses.controller';

const router = express.Router();

// All routes require authentication and store context
router.use(protect);

/**
 * @openapi
 * /recurring-expenses:
 *   get:
 *     tags: [Recurring Expenses]
 *     summary: Get all recurring expenses
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of recurring expenses
 *   post:
 *     tags: [Recurring Expenses]
 *     summary: Create a new recurring expense
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
 *               frequency: { type: string, enum: [daily, weekly, monthly, quarterly, yearly] }
 *               startDate: { type: string, format: date }
 *               expenseAccountId: { type: string }
 *               paymentAccountId: { type: string }
 */
router.get('/', recurringExpensesController.getRecurringExpenses);
router.post('/', recurringExpensesController.createRecurringExpense);

/**
 * @openapi
 * /recurring-expenses/{id}:
 *   put:
 *     tags: [Recurring Expenses]
 *     summary: Update a recurring expense
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   delete:
 *     tags: [Recurring Expenses]
 *     summary: Delete a recurring expense
 *     security:
 *       - bearerAuth: []
 */
router.put('/:id', recurringExpensesController.updateRecurringExpense);
router.delete('/:id', recurringExpensesController.deleteRecurringExpense);

/**
 * @openapi
 * /recurring-expenses/process:
 *   post:
 *     tags: [Recurring Expenses]
 *     summary: Manually trigger processing of due recurring expenses
 *     security:
 *       - bearerAuth: []
 */
router.post('/process', recurringExpensesController.processRecurringExpenses);

export default router;
