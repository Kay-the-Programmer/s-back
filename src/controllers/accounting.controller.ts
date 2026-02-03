import express from 'express';
import db from '../db_client';
import { Account, JournalEntry, SupplierInvoice, SupplierPayment, Sale, Customer } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';


// --- Chart of Accounts ---
export const getAccounts = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query('SELECT * FROM accounts WHERE store_id = $1 ORDER BY number', [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        res.status(500).json({ message: 'Error fetching accounts' });
    }
};
export const createAccount = async (req: express.Request, res: express.Response) => {
    const { name, number, type, description } = req.body;
    const id = generateId('acc');
    const isDebitNormal = type === 'asset' || type === 'expense';
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query(
            'INSERT INTO accounts (id, name, number, type, is_debit_normal, description, balance, store_id) VALUES ($1, $2, $3, $4, $5, $6, 0, $7) RETURNING *',
            [id, name, number, type, isDebitNormal, description, storeId]
        );
        auditService.log(req.user!, 'Account Created', `Account: ${name} (${number})`);
        res.status(201).json(toCamelCase(result.rows[0]));
    } catch (error) {
        res.status(500).json({ message: 'Error creating account' });
    }
};
export const updateAccount = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { name, number, type, description } = req.body;
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query(
            'UPDATE accounts SET name=$1, number=$2, type=$3, description=$4 WHERE id=$5 AND store_id=$6 RETURNING *',
            [name, number, type, description, id, storeId]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Account not found' });
        auditService.log(req.user!, 'Account Updated', `Account: ${name} (${number})`);
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        res.status(500).json({ message: 'Error updating account' });
    }
};
export const deleteAccount = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query('DELETE FROM accounts WHERE id=$1 AND store_id=$2 RETURNING name, number', [id, storeId]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Account not found' });
        auditService.log(req.user!, 'Account Deleted', `Account: ${result.rows[0].name} (${result.rows[0].number})`);
        res.status(200).json({ message: 'Account deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Cannot delete account, it may be in use.' });
    }
};

export const adjustAccountBalance = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { adjustmentAmount, offsetAccountId, offsetAccountName, description } = req.body;

    if (!adjustmentAmount || !offsetAccountId || !description) {
        return res.status(400).json({ message: 'Missing required fields: adjustmentAmount, offsetAccountId, description' });
    }

    const client = await (db as any)._pool.connect();

    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        await client.query('BEGIN');

        // Get the account being adjusted
        const accountResult = await client.query(
            'SELECT * FROM accounts WHERE id = $1 AND store_id = $2',
            [id, storeId]
        );

        if (accountResult.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Account not found' });
        }

        const account = toCamelCase(accountResult.rows[0]);

        // Determine debit/credit based on account normal balance and adjustment direction
        const isIncrease = adjustmentAmount > 0;
        const absAmount = Math.abs(adjustmentAmount);

        let targetAccountType: 'debit' | 'credit';
        let offsetAccountType: 'debit' | 'credit';

        if (isIncrease) {
            // Increase account balance
            targetAccountType = account.isDebitNormal ? 'debit' : 'credit';
            offsetAccountType = account.isDebitNormal ? 'credit' : 'debit';
        } else {
            // Decrease account balance
            targetAccountType = account.isDebitNormal ? 'credit' : 'debit';
            offsetAccountType = account.isDebitNormal ? 'debit' : 'credit';
        }

        // Create journal entry for adjustment
        const entryId = generateId('je');
        await client.query(
            'INSERT INTO journal_entries (id, date, description, source_type, source_id, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [entryId, new Date().toISOString(), description, 'manual', null, storeId]
        );

        // Add journal entry lines
        await client.query(
            'INSERT INTO journal_entry_lines (journal_entry_id, account_id, type, amount, account_name, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [entryId, id, targetAccountType, absAmount, account.name, storeId]
        );

        await client.query(
            'INSERT INTO journal_entry_lines (journal_entry_id, account_id, type, amount, account_name, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [entryId, offsetAccountId, offsetAccountType, absAmount, offsetAccountName, storeId]
        );

        // Update account balances
        let targetChange = absAmount;
        if ((account.isDebitNormal && targetAccountType === 'credit') || (!account.isDebitNormal && targetAccountType === 'debit')) {
            targetChange = -targetChange;
        }
        await client.query(
            'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND store_id = $3',
            [targetChange, id, storeId]
        );

        // Update offset account balance
        const offsetAccountResult = await client.query(
            'SELECT is_debit_normal FROM accounts WHERE id = $1 AND store_id = $2',
            [offsetAccountId, storeId]
        );
        if (offsetAccountResult.rowCount > 0) {
            const offsetAcc = offsetAccountResult.rows[0];
            let offsetChange = absAmount;
            if ((offsetAcc.is_debit_normal && offsetAccountType === 'credit') || (!offsetAcc.is_debit_normal && offsetAccountType === 'debit')) {
                offsetChange = -offsetChange;
            }
            await client.query(
                'UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND store_id = $3',
                [offsetChange, offsetAccountId, storeId]
            );
        }

        await client.query('COMMIT');

        auditService.log(req.user!, 'Account Balance Adjusted', `Account: ${account.name}, Amount: ${adjustmentAmount}, Reason: ${description}`);
        res.status(200).json({ message: 'Account balance adjusted successfully', entryId });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adjusting account balance:', error);
        res.status(500).json({ message: 'Error adjusting account balance' });
    } finally {
        client.release();
    }
};

export const getFinancialOverview = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const { startDate, endDate } = req.query as { startDate?: string, endDate?: string };
        const adjustedEndDate = endDate ? new Date(new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString() : new Date().toISOString();
        const start = startDate || new Date(0).toISOString(); // Default to beginning of time if no start date

        // 1. Sub-ledger Stats
        const inventoryQuery = `SELECT COALESCE(SUM(cost_price * stock), 0) as "inventoryValue" FROM products WHERE store_id = $1 AND status = 'active'`;
        const arQuery = `SELECT COALESCE(SUM(account_balance), 0) as "accountsReceivable" FROM customers WHERE store_id = $1`;
        const apQuery = `SELECT COALESCE(SUM(amount - amount_paid), 0) as "accountsPayable" FROM supplier_invoices WHERE store_id = $1`;

        // 2. GL Balances
        const glBalancesQuery = `
            SELECT 
                type,
                sub_type as "subType",
                COALESCE(SUM(balance), 0) as balance
            FROM accounts 
            WHERE store_id = $1 
            GROUP BY type, sub_type
        `;

        // 3. Profit & Loss (Period-bound)
        const revenueQuery = `
            SELECT COALESCE(SUM(subtotal), 0) as revenue 
            FROM sales 
            WHERE store_id = $1 AND payment_status = 'paid' AND timestamp BETWEEN $2 AND $3
        `;
        const cogsQuery = `
            SELECT COALESCE(SUM(si.cost_at_sale * (si.quantity - si.returned_quantity)), 0) as cogs
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.transaction_id
            WHERE s.store_id = $1 AND s.payment_status = 'paid' AND s.timestamp BETWEEN $2 AND $3
        `;
        const expensesQuery = `
            SELECT COALESCE(SUM(amount), 0) as expenses 
            FROM expenses 
            WHERE store_id = $1 AND date BETWEEN $2 AND $3
        `;
        const refundsQuery = `
            SELECT COALESCE(SUM(subtotal_amount), 0) as refunds
            FROM returns
            WHERE store_id = $1 AND timestamp BETWEEN $2 AND $3
        `;

        const [
            invResult, arResult, apResult, glResult, revResult, cogsResult, expResult, refResult
        ] = await Promise.all([
            db.query(inventoryQuery, [storeId]),
            db.query(arQuery, [storeId]),
            db.query(apQuery, [storeId]),
            db.query(glBalancesQuery, [storeId]),
            db.query(revenueQuery, [storeId, start, adjustedEndDate]),
            db.query(cogsQuery, [storeId, start, adjustedEndDate]),
            db.query(expensesQuery, [storeId, start, adjustedEndDate]),
            db.query(refundsQuery, [storeId, start, adjustedEndDate])
        ]);

        const inventoryValue = parseFloat(invResult.rows[0].inventoryValue);
        const accountsReceivable = parseFloat(arResult.rows[0].accountsReceivable);
        const accountsPayable = parseFloat(apResult.rows[0].accountsPayable);

        const glBalances = glResult.rows.map(r => ({ ...r, balance: parseFloat(r.balance) }));
        const cashBalance = glBalances.filter(b => b.subType === 'cash').reduce((sum, b) => sum + b.balance, 0);

        const periodGrossSales = parseFloat(revResult.rows[0].revenue);
        const periodRefunds = parseFloat(refResult.rows[0].refunds);
        const periodNetRevenue = periodGrossSales - periodRefunds;
        const periodCogs = parseFloat(cogsResult.rows[0].cogs);
        const periodExpenses = parseFloat(expResult.rows[0].expenses);
        const periodNetIncome = (periodNetRevenue - periodCogs) - periodExpenses;

        // Total Assets from GL (for comparison)
        const totalAssetsGL = glBalances.filter(b => b.type === 'asset').reduce((sum, b) => sum + b.balance, 0);
        const totalLiabilitiesGL = glBalances.filter(b => b.type === 'liability').reduce((sum, b) => sum + b.balance, 0);

        res.status(200).json({
            summary: {
                inventoryValue,
                accountsReceivable,
                accountsPayable,
                cashBalance,
                totalAssets: totalAssetsGL,
                totalLiabilities: totalLiabilitiesGL,
                equity: totalAssetsGL - totalLiabilitiesGL
            },
            period: {
                revenue: periodNetRevenue,
                cogs: periodCogs,
                expenses: periodExpenses,
                grossProfit: periodNetRevenue - periodCogs,
                netIncome: periodNetIncome
            },
            checks: {
                arMatch: Math.abs(accountsReceivable - (glBalances.find(b => b.subType === 'accounts_receivable')?.balance || 0)) < 0.01,
                apMatch: Math.abs(accountsPayable - (glBalances.find(b => b.subType === 'accounts_payable')?.balance || 0)) < 0.01,
                inventoryMatch: Math.abs(inventoryValue - (glBalances.find(b => b.subType === 'inventory')?.balance || 0)) < 0.01
            }
        });
    } catch (error) {
        console.error('Error fetching financial overview:', error);
        res.status(500).json({ message: 'Error fetching financial overview' });
    }
};

// --- Journal Entries ---
export const getJournalEntries = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query(`
            SELECT je.*, COALESCE(json_agg(jel.*) FILTER (WHERE jel.id IS NOT NULL), '[]') as lines
            FROM journal_entries je
            LEFT JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id AND jel.store_id = $1
            WHERE je.store_id = $1
            GROUP BY je.id, je.date
            ORDER BY je.date DESC
        `, [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        res.status(500).json({ message: 'Error fetching journal entries' });
    }
};
export const createManualJournalEntry = async (req: express.Request, res: express.Response) => {
    const entryData: Omit<JournalEntry, 'id'> = req.body;
    const totalDebits = entryData.lines.filter(l => l.type === 'debit').reduce((sum, l) => sum + l.amount, 0);
    const totalCredits = entryData.lines.filter(l => l.type === 'credit').reduce((sum, l) => sum + l.amount, 0);
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
        return res.status(400).json({ message: 'Debits do not equal credits.' });
    }

    try {
        // This should be a transaction
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const entryId = generateId('je');
        await db.query('INSERT INTO journal_entries (id, date, description, source_type, source_id, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [entryId, entryData.date, entryData.description, 'manual', null, storeId]
        );
        for (const line of entryData.lines) {
            await db.query('INSERT INTO journal_entry_lines (journal_entry_id, account_id, type, amount, account_name, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [entryId, line.accountId, line.type, line.amount, line.accountName, storeId]
            );
        }

        auditService.log(req.user!, 'Manual Journal Entry Created', `Description: ${entryData.description}`);
        res.status(201).json(toCamelCase({ id: entryId, ...entryData }));
    } catch (error) {
        res.status(500).json({ message: 'Error creating manual entry' });
    }
};

// --- Supplier Invoices ---
export const getSupplierInvoices = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query(`
            SELECT si.*, COALESCE(json_agg(sp.*) FILTER (WHERE sp.id IS NOT NULL), '[]') as payments
            FROM supplier_invoices si
            LEFT JOIN supplier_payments sp ON si.id = sp.supplier_invoice_id AND sp.store_id = $1
            WHERE si.store_id = $1
            GROUP BY si.id, si.invoice_date
            ORDER BY si.invoice_date DESC
        `, [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        res.status(500).json({ message: 'Error fetching supplier invoices' });
    }
};
export const createSupplierInvoice = async (req: express.Request, res: express.Response) => {
    const { invoiceNumber, supplierId, supplierName, purchaseOrderId, poNumber, invoiceDate, dueDate, amount } = req.body;
    const id = generateId('inv-sup');
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query(
            'INSERT INTO supplier_invoices (id, invoice_number, supplier_id, supplier_name, purchase_order_id, po_number, invoice_date, due_date, amount, amount_paid, status, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, \'unpaid\', $10) RETURNING *',
            [id, invoiceNumber, supplierId, supplierName, purchaseOrderId, poNumber, invoiceDate, dueDate, amount, storeId]
        );
        auditService.log(req.user!, 'Supplier Invoice Created', `Invoice #: ${invoiceNumber} for ${supplierName}`);
        res.status(201).json(toCamelCase(result.rows[0]));
    } catch (error) {
        res.status(500).json({ message: 'Error creating supplier invoice' });
    }
};
export const updateSupplierInvoice = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { invoiceNumber, supplierId, supplierName, purchaseOrderId, poNumber, invoiceDate, dueDate, amount } = req.body;
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const result = await db.query(
            'UPDATE supplier_invoices SET invoice_number=$1, supplier_id=$2, supplier_name=$3, purchase_order_id=$4, po_number=$5, invoice_date=$6, due_date=$7, amount=$8 WHERE id=$9 AND store_id=$10 RETURNING *',
            [invoiceNumber, supplierId, supplierName, purchaseOrderId, poNumber, invoiceDate, dueDate, amount, id, storeId]
        );
        if (result.rowCount === 0) return res.status(404).json({ message: 'Invoice not found' });
        auditService.log(req.user!, 'Supplier Invoice Updated', `Invoice #: ${invoiceNumber}`);
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        res.status(500).json({ message: 'Error updating supplier invoice' });
    }
};
export const recordSupplierPayment = async (req: express.Request, res: express.Response) => {
    const { id: invoiceId } = req.params;
    const paymentData: Omit<SupplierPayment, 'id'> = req.body;
    const client = await (db as any)._pool.connect();

    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        await client.query('BEGIN');

        const invoiceRes = await client.query('SELECT * FROM supplier_invoices WHERE id = $1 AND store_id = $2', [invoiceId, storeId]);
        if (invoiceRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Invoice not found' });
        }

        const invoice = toCamelCase(invoiceRes.rows[0]);

        // Work in cents to avoid floating point rounding errors
        const amountCents = Math.round(invoice.amount * 100);
        const paidCents = Math.round(invoice.amountPaid * 100);
        const remainingCents = Math.max(0, amountCents - paidCents);
        const paymentCents = Math.round(paymentData.amount * 100);

        // Block payments when invoice is already fully paid
        if (remainingCents <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'Invoice is already fully paid. No additional payments are allowed.' });
        }
        // Prevent overpayments beyond the remaining balance
        if (paymentCents > remainingCents) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `Payment exceeds remaining balance. Remaining due is ${(remainingCents / 100).toFixed(2)}.` });
        }

        const newPaidCents = paidCents + paymentCents;
        const newStatus: SupplierInvoice['status'] = newPaidCents >= amountCents ? 'paid' : 'partially_paid';
        const newAmountPaid = newPaidCents / 100;
        const paymentId = generateId('spay');

        await client.query(
            'INSERT INTO supplier_payments (id, supplier_invoice_id, date, amount, method, reference, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [paymentId, invoiceId, paymentData.date, paymentData.amount, paymentData.method, paymentData.reference, storeId]
        );

        await client.query(
            'UPDATE supplier_invoices SET amount_paid = $1, status = $2 WHERE id = $3 AND store_id = $4',
            [newAmountPaid, newStatus, invoiceId, storeId]
        );

        // Record the financial transaction in the journal
        await accountingService.recordSupplierPayment(invoice, { ...paymentData, id: paymentId }, client, storeId);

        await client.query('COMMIT');

        auditService.log(req.user!, 'Supplier Payment Recorded', `For Invoice ID: ${invoiceId}, Amount: ${paymentData.amount.toFixed(2)}`);
        res.status(200).json({ ...invoice, amountPaid: newAmountPaid, status: newStatus });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error recording supplier payment:', error);
        res.status(500).json({ message: 'Error recording supplier payment' });
    } finally {
        client.release();
    }
};