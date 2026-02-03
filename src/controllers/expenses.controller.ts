import express from 'express';
import db from '../db_client';
import { Expense } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';

// --- Expenses ---
export const getExpenses = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const { startDate, endDate, category, search, limit, offset } = req.query as {
            startDate?: string,
            endDate?: string,
            category?: string,
            search?: string,
            limit?: string,
            offset?: string
        };

        let query = 'SELECT * FROM expenses WHERE store_id = $1';
        const params: any[] = [storeId];
        let paramIndex = 2;

        if (startDate) {
            query += ` AND date >= $${paramIndex++}`;
            params.push(startDate);
        }

        if (endDate) {
            query += ` AND date <= $${paramIndex++}`;
            params.push(endDate);
        }

        if (category) {
            query += ` AND category = $${paramIndex++}`;
            params.push(category);
        }

        if (search) {
            query += ` AND (description ILIKE $${paramIndex} OR reference ILIKE $${paramIndex})`;
            params.push(`%${search}%`);
            paramIndex++;
        }

        query += ' ORDER BY date DESC';

        if (limit) {
            query += ` LIMIT $${paramIndex++}`;
            params.push(parseInt(limit, 10));
        }

        if (offset) {
            query += ` OFFSET $${paramIndex++}`;
            params.push(parseInt(offset, 10));
        }

        const result = await db.query(query, params);

        // Also get total count and total amount for the filtered set
        let totalCount = result.rowCount;
        let totalAmount = 0;

        let countQuery = 'SELECT COUNT(*), COALESCE(SUM(amount), 0) as total_amount FROM expenses WHERE store_id = $1';
        const countParams: any[] = [storeId];
        let countParamIndex = 2;

        if (startDate) {
            countQuery += ` AND date >= $${countParamIndex++}`;
            countParams.push(startDate);
        }
        if (endDate) {
            countQuery += ` AND date <= $${countParamIndex++}`;
            countParams.push(endDate);
        }
        if (category) {
            countQuery += ` AND category = $${countParamIndex++}`;
            countParams.push(category);
        }
        if (search) {
            countQuery += ` AND (description ILIKE $${countParamIndex} OR reference ILIKE $${countParamIndex})`;
            countParams.push(`%${search}%`);
        }

        const countResult = await db.query(countQuery, countParams);
        totalCount = parseInt(countResult.rows[0].count, 10);
        totalAmount = parseFloat(countResult.rows[0].total_amount);

        res.status(200).json({
            items: toCamelCase(result.rows),
            totalCount,
            totalAmount
        });
    } catch (error) {
        console.error('Error fetching expenses:', error);
        res.status(500).json({ message: 'Error fetching expenses' });
    }
};

export const getExpenseById = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const result = await db.query(
            'SELECT * FROM expenses WHERE id = $1 AND store_id = $2',
            [id, storeId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Expense not found' });
        }
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error('Error fetching expense:', error);
        res.status(500).json({ message: 'Error fetching expense' });
    }
};

export const createExpense = async (req: express.Request, res: express.Response) => {
    const { date, description, amount, expenseAccountId, expenseAccountName, paymentAccountId, paymentAccountName, category, reference } = req.body;

    if (!date || !description || !amount || !expenseAccountId || !paymentAccountId) {
        return res.status(400).json({ message: 'Missing required fields' });
    }

    const id = generateId('exp');
    const userId = req.user?.id || 'unknown';
    const client = await (db as any)._pool.connect();

    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        await client.query('BEGIN');

        // Insert expense record
        const result = await client.query(
            `INSERT INTO expenses (id, store_id, date, description, amount, expense_account_id, expense_account_name, payment_account_id, payment_account_name, category, reference, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
            [id, storeId, date, description, amount, expenseAccountId, expenseAccountName, paymentAccountId, paymentAccountName, category, reference, userId]
        );

        // Record the expense in the accounting system via journal entry
        await accountingService.recordExpense({
            id,
            date,
            description,
            amount,
            expenseAccountId,
            expenseAccountName,
            paymentAccountId,
            paymentAccountName,
            category,
            reference,
            createdBy: userId,
            createdAt: new Date().toISOString()
        }, client, storeId);

        await client.query('COMMIT');

        auditService.log(req.user!, 'Expense Created', `Expense: ${description} - Amount: ${amount}`);
        res.status(201).json(toCamelCase(result.rows[0]));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating expense:', error);
        res.status(500).json({ message: 'Error creating expense' });
    } finally {
        client.release();
    }
};

export const updateExpense = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { date, description, amount, expenseAccountId, expenseAccountName, paymentAccountId, paymentAccountName, category, reference } = req.body;

    const client = await (db as any)._pool.connect();

    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        await client.query('BEGIN');

        // Get old expense to reverse its journal entry
        const oldExpenseResult = await client.query(
            'SELECT * FROM expenses WHERE id = $1 AND store_id = $2',
            [id, storeId]
        );

        if (oldExpenseResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Expense not found' });
        }

        const oldExpense = toCamelCase(oldExpenseResult.rows[0]);

        // Reverse old journal entry
        await accountingService.reverseExpense(oldExpense, client, storeId);

        // Update expense record
        const result = await client.query(
            `UPDATE expenses 
             SET date = $1, description = $2, amount = $3, expense_account_id = $4, expense_account_name = $5,
                 payment_account_id = $6, payment_account_name = $7, category = $8, reference = $9
             WHERE id = $10 AND store_id = $11 RETURNING *`,
            [date, description, amount, expenseAccountId, expenseAccountName, paymentAccountId, paymentAccountName, category, reference, id, storeId]
        );

        // Record new journal entry
        await accountingService.recordExpense(toCamelCase(result.rows[0]), client, storeId);

        await client.query('COMMIT');

        auditService.log(req.user!, 'Expense Updated', `Expense ID: ${id} - ${description}`);
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating expense:', error);
        res.status(500).json({ message: 'Error updating expense' });
    } finally {
        client.release();
    }
};

export const deleteExpense = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const client = await (db as any)._pool.connect();

    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        await client.query('BEGIN');

        // Get expense to reverse its journal entry
        const expenseResult = await client.query(
            'SELECT * FROM expenses WHERE id = $1 AND store_id = $2',
            [id, storeId]
        );

        if (expenseResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Expense not found' });
        }

        const expense = toCamelCase(expenseResult.rows[0]);

        // Reverse journal entry
        await accountingService.reverseExpense(expense, client, storeId);

        // Delete expense
        await client.query('DELETE FROM expenses WHERE id = $1 AND store_id = $2', [id, storeId]);

        await client.query('COMMIT');

        auditService.log(req.user!, 'Expense Deleted', `Expense ID: ${id} - ${expense.description}`);
        res.status(200).json({ message: 'Expense deleted successfully' });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error deleting expense:', error);
        res.status(500).json({ message: 'Error deleting expense' });
    } finally {
        client.release();
    }
};
