import express from 'express';
import { protect } from '../middleware/auth.middleware';
import * as recurringExpensesController from '../controllers/recurring-expenses.controller';

const router = express.Router();

// All routes require authentication and store context
router.use(protect);

router.get('/', recurringExpensesController.getRecurringExpenses);
router.post('/', recurringExpensesController.createRecurringExpense);
router.put('/:id', recurringExpensesController.updateRecurringExpense);
router.delete('/:id', recurringExpensesController.deleteRecurringExpense);
router.post('/process', recurringExpensesController.processRecurringExpenses);

export default router;
