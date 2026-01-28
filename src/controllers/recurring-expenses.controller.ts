import express from 'express';
import db from '../db_client';
import { RecurringExpense } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';

export const getRecurringExpenses = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const result = await db.query(
            'SELECT * FROM recurring_expenses WHERE store_id = $1 ORDER BY created_at DESC',
            [storeId]
        );
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching recurring expenses:', error);
        res.status(500).json({ message: 'Error fetching recurring expenses' });
    }
};

export const createRecurringExpense = async (req: express.Request, res: express.Response) => {
    const {
        description,
        amount,
        expenseAccountId,
        expenseAccountName,
        paymentAccountId,
        paymentAccountName,
        category,
        reference,
        frequency,
        startDate
    } = req.body;

    if (!description || !amount || !expenseAccountId || !paymentAccountId || !frequency || !startDate) {
        return res.status(400).json({ message: 'Missing required fields' });
    }

    const id = generateId('rexp');
    const userId = req.user?.id || 'unknown';
    const storeId = (req as any).tenant?.storeId;

    if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

    try {
        // nextRunDate is initially the startDate
        const result = await db.query(
            `INSERT INTO recurring_expenses (
                id, store_id, description, amount, expense_account_id, expense_account_name, 
                payment_account_id, payment_account_name, category, reference, 
                frequency, start_date, next_run_date, created_by
            )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *`,
            [
                id, storeId, description, amount, expenseAccountId, expenseAccountName,
                paymentAccountId, paymentAccountName, category, reference,
                frequency, startDate, startDate, userId
            ]
        );

        auditService.log(req.user!, 'Recurring Expense Created', `Recurring Expense: ${description} - Frequency: ${frequency}`);
        res.status(201).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error('Error creating recurring expense:', error);
        res.status(500).json({ message: 'Error creating recurring expense' });
    }
};

export const updateRecurringExpense = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const {
        description,
        amount,
        expenseAccountId,
        expenseAccountName,
        paymentAccountId,
        paymentAccountName,
        category,
        reference,
        frequency,
        status
    } = req.body;

    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const result = await db.query(
            `UPDATE recurring_expenses 
             SET description = $1, amount = $2, expense_account_id = $3, expense_account_name = $4,
                 payment_account_id = $5, payment_account_name = $6, category = $7, reference = $8,
                 frequency = $9, status = $10, updated_at = NOW()
             WHERE id = $11 AND store_id = $12 RETURNING *`,
            [description, amount, expenseAccountId, expenseAccountName, paymentAccountId, paymentAccountName, category, reference, frequency, status, id, storeId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Recurring expense not found' });
        }

        auditService.log(req.user!, 'Recurring Expense Updated', `Recurring Expense: ${id} - ${description}`);
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error('Error updating recurring expense:', error);
        res.status(500).json({ message: 'Error updating recurring expense' });
    }
};

export const deleteRecurringExpense = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const result = await db.query('DELETE FROM recurring_expenses WHERE id = $1 AND store_id = $2', [id, storeId]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Recurring expense not found' });
        }

        auditService.log(req.user!, 'Recurring Expense Deleted', `Recurring Expense ID: ${id}`);
        res.status(200).json({ message: 'Recurring expense deleted successfully' });
    } catch (error) {
        console.error('Error deleting recurring expense:', error);
        res.status(500).json({ message: 'Error deleting recurring expense' });
    }
};

export const processRecurringExpenses = async (req: express.Request, res: express.Response) => {
    // This could be manual or triggered by a webhook/cron
    // For simplicity, we'll provide an endpoint that can be called
    try {
        const count = await runRecurringExpenses();
        res.status(200).json({ message: `Processed ${count} recurring expenses.` });
    } catch (error) {
        console.error('Error processing recurring expenses:', error);
        res.status(500).json({ message: 'Error processing recurring expenses' });
    }
};

export const runRecurringExpenses = async (): Promise<number> => {
    const today = new Date().toISOString().split('T')[0];
    const client = await (db as any)._pool.connect();
    let processedCount = 0;

    try {
        await client.query('BEGIN');

        // Find all active recurring expenses where next_run_date <= today
        const result = await client.query(
            `SELECT * FROM recurring_expenses WHERE status = 'active' AND next_run_date <= $1`,
            [today]
        );

        const recurringExpenses = toCamelCase(result.rows) as RecurringExpense[];

        for (const rexp of recurringExpenses) {
            const expenseId = generateId('exp');

            // 1. Create the actual expense record
            await client.query(
                `INSERT INTO expenses (id, store_id, date, description, amount, expense_account_id, expense_account_name, payment_account_id, payment_account_name, category, reference, created_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
                [
                    expenseId,
                    (rexp as any).storeId,
                    rexp.nextRunDate,
                    rexp.description,
                    rexp.amount,
                    rexp.expenseAccountId,
                    rexp.expenseAccountName,
                    rexp.paymentAccountId,
                    rexp.paymentAccountName,
                    rexp.category,
                    rexp.reference,
                    'system'
                ]
            );

            // 2. Record in accounting
            await accountingService.recordExpense({
                id: expenseId,
                date: rexp.nextRunDate,
                description: rexp.description,
                amount: rexp.amount,
                expenseAccountId: rexp.expenseAccountId,
                expenseAccountName: rexp.expenseAccountName,
                paymentAccountId: rexp.paymentAccountId,
                paymentAccountName: rexp.paymentAccountName,
                category: rexp.category,
                reference: rexp.reference,
                createdBy: 'system',
                createdAt: new Date().toISOString()
            }, client, (rexp as any).storeId);

            // 3. Update next_run_date based on frequency
            const nextDate = calculateNextRunDate(rexp.nextRunDate, rexp.frequency);
            await client.query(
                'UPDATE recurring_expenses SET next_run_date = $1, updated_at = NOW() WHERE id = $2',
                [nextDate, rexp.id]
            );

            processedCount++;
        }

        await client.query('COMMIT');
        return processedCount;
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error running recurring expenses:', error);
        throw error;
    } finally {
        client.release();
    }
};

function calculateNextRunDate(currentDateStr: string, frequency: string): string {
    const date = new Date(currentDateStr);
    switch (frequency) {
        case 'daily':
            date.setDate(date.getDate() + 1);
            break;
        case 'weekly':
            date.setDate(date.getDate() + 7);
            break;
        case 'monthly':
            date.setMonth(date.getMonth() + 1);
            break;
        case 'quarterly':
            date.setMonth(date.getMonth() + 3);
            break;
        case 'yearly':
            date.setFullYear(date.getFullYear() + 1);
            break;
    }
    return date.toISOString().split('T')[0];
}
