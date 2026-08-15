import express from 'express';
import db from '../db_client';
import { Expense } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';
import { roleHasPermission, Role } from '../auth/rbac';

/**
 * Callers holding `expenses:manage` (admin) see the whole store's expenses.
 * Everyone else who may reach these routes holds only `expenses:record`, and
 * sees exactly the expenses they recorded — enforced here, in the queries, so
 * it can't be bypassed by hitting an endpoint directly.
 */
/**
 * Accounts an expense can be paid from — mirrors the web expense form
 * (components/accounting/ExpenseFormModal.tsx): cash, or on account.
 */
const PAYMENT_SUB_TYPES = ['cash', 'accounts_payable'];

const ownExpensesOnly = (req: express.Request): string | null =>
    roleHasPermission(req.user?.role as Role | undefined, 'expenses:manage')
        ? null
        : (req.user?.id ?? 'unknown');

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

        const restrictTo = ownExpensesOnly(req);

        let query = 'SELECT * FROM expenses WHERE store_id = $1';
        const params: any[] = [storeId];
        let paramIndex = 2;

        if (restrictTo) {
            query += ` AND created_by = $${paramIndex++}`;
            params.push(restrictTo);
        }

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

        if (restrictTo) {
            countQuery += ` AND created_by = $${countParamIndex++}`;
            countParams.push(restrictTo);
        }

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

        const restrictTo = ownExpensesOnly(req);
        const result = await db.query(
            restrictTo
                ? 'SELECT * FROM expenses WHERE id = $1 AND store_id = $2 AND created_by = $3'
                : 'SELECT * FROM expenses WHERE id = $1 AND store_id = $2',
            restrictTo ? [id, storeId, restrictTo] : [id, storeId]
        );
        if (result.rowCount === 0) {
            // Someone else's expense reads as "not found" — no existence leak.
            return res.status(404).json({ message: 'Expense not found' });
        }
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error('Error fetching expense:', error);
        res.status(500).json({ message: 'Error fetching expense' });
    }
};

/**
 * The accounts a recording form may offer: expense categories to charge, and
 * the asset accounts (cash / bank / mobile money) an expense can be paid from.
 *
 * Exists so recording an expense doesn't require access to the chart of
 * accounts — staff hold `expenses:record`, not `accounting:manage`.
 */
export const getExpenseAccountOptions = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const result = await db.query(
            `SELECT id, name, number, type, sub_type FROM accounts
             WHERE store_id = $1 AND (type = 'expense' OR sub_type = ANY($2::text[]))
             ORDER BY number`,
            [storeId, PAYMENT_SUB_TYPES]
        );
        const rows = toCamelCase(result.rows) as
            { id: string; name: string; number: string; type: string; subType: string | null }[];
        res.status(200).json({
            expenseAccounts: rows.filter(a => a.type === 'expense'),
            // Same set the web expense form offers: pay in cash, or put it on
            // account. Receivables and inventory are assets but not ways to pay.
            paymentAccounts: rows.filter(a => a.subType && PAYMENT_SUB_TYPES.includes(a.subType)),
        });
    } catch (error) {
        console.error('Error fetching expense account options:', error);
        res.status(500).json({ message: 'Error fetching accounts' });
    }
};

export const createExpense = async (req: express.Request, res: express.Response) => {
    const { date, description, amount, expenseAccountId, expenseAccountName, paymentAccountId, paymentAccountName, category, reference } = req.body;
    // The store's own tender name (CASH / AIRTEL / MTN …), recorded alongside
    // the GL account the money is posted against. Optional: older clients and
    // the recurring-expense job don't send it.
    const paymentMethod = typeof req.body?.paymentMethod === 'string' && req.body.paymentMethod.trim()
        ? req.body.paymentMethod.trim()
        : null;

    if (!date || !description || !amount || !expenseAccountId || !paymentAccountId) {
        return res.status(400).json({ message: 'Missing required fields' });
    }

    const numericAmount = Number(amount);
    if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
        return res.status(400).json({ message: 'Amount must be a positive number.' });
    }

    const id = generateId('exp');
    const userId = req.user?.id || 'unknown';
    const client = await (db as any)._pool.connect();

    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        // Both accounts must belong to this store and be of the right kind.
        // This route is no longer admin-only, so the posted account ids can't be
        // taken on trust: without this a caller could charge any account in the
        // ledger, or another store's.
        const accounts = await client.query(
            `SELECT id, name, type, sub_type FROM accounts WHERE store_id = $1 AND id = ANY($2::text[])`,
            [storeId, [expenseAccountId, paymentAccountId]]
        );
        const byId = new Map<string, { id: string; name: string; type: string; sub_type: string | null }>(
            accounts.rows.map((r: any) => [r.id, r])
        );
        const expenseAccount = byId.get(expenseAccountId);
        const paymentAccount = byId.get(paymentAccountId);
        if (!expenseAccount || expenseAccount.type !== 'expense') {
            return res.status(400).json({ message: 'Unknown or invalid expense account.' });
        }
        if (!paymentAccount || !paymentAccount.sub_type || !PAYMENT_SUB_TYPES.includes(paymentAccount.sub_type)) {
            return res.status(400).json({ message: 'Unknown or invalid payment account.' });
        }
        // Names come from the ledger, not the request — a client can't relabel
        // an account by posting a different name alongside the id.
        const chargedTo = expenseAccount.name ?? expenseAccountName;
        const paidFrom = paymentAccount.name ?? paymentAccountName;

        await client.query('BEGIN');

        // Insert expense record
        const result = await client.query(
            `INSERT INTO expenses (id, store_id, date, description, amount, expense_account_id, expense_account_name, payment_account_id, payment_account_name, category, reference, created_by, payment_method)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING *`,
            [id, storeId, date, description, numericAmount, expenseAccountId, chargedTo, paymentAccountId, paidFrom, category, reference, userId, paymentMethod]
        );

        // Record the expense in the accounting system via journal entry
        await accountingService.recordExpense({
            id,
            date,
            description,
            amount: numericAmount,
            expenseAccountId,
            expenseAccountName: chargedTo,
            paymentAccountId,
            paymentAccountName: paidFrom,
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
