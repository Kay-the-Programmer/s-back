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
        // Make sure the standard chart exists before showing it — otherwise a new
        // store (or one created before an account was added) sees gaps, e.g. no
        // Utilities account for the expense form to post to.
        await accountingService.ensureCoreAccounts(storeId);
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

/**
 * Accounts a manual entry must not touch, because each is kept in step with
 * its own records: customer balances (Receivables), supplier bills (Payables),
 * stock on hand (Inventory) and customers' store credit. A manual posting to
 * any of them makes the books disagree with those records with no trace of
 * why. Use the invoice, bill, stock or customer screens instead.
 */
const CONTROL_SUB_TYPES: Record<string, string> = {
    accounts_receivable: 'record a customer payment or refund instead',
    accounts_payable: 'record or edit the supplier bill instead',
    inventory: 'use a stock adjustment or stock take instead',
    store_credit_payable: 'change the customer’s store credit instead',
};

/** Why a manual posting to these accounts is refused, or null when it is fine. */
const refuseManualPosting = async (storeId: string, accountIds: string[]): Promise<string | null> => {
    const ids = [...new Set(accountIds.filter(Boolean))];
    if (ids.length === 0) return 'Pick an account for every line.';
    const { rows } = await db.query('SELECT id, name, sub_type FROM accounts WHERE store_id = $1 AND id = ANY($2::text[])', [storeId, ids]);
    if (rows.length !== ids.length) return 'One of those accounts does not belong to this shop.';
    for (const r of rows) {
        const why = r.sub_type && CONTROL_SUB_TYPES[r.sub_type];
        if (why) return `${r.name} can't be changed by a manual entry — ${why}, so it stays in step with its records.`;
    }
    return null;
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

        // Both sides must be this shop's accounts, and neither a control account.
        const refusal = await refuseManualPosting(storeId, [id, offsetAccountId]);
        if (refusal) return res.status(400).json({ message: refusal }); // finally releases the client

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

        // Post through the single journal engine (balance check + account balance
        // updates live in one place instead of a second hand-rolled implementation).
        await accountingService.addJournalEntry({
            date: new Date().toISOString(),
            description,
            source: { type: 'manual' },
            lines: [
                { accountId: id, accountName: account.name, type: targetAccountType, amount: absAmount },
                { accountId: offsetAccountId, accountName: offsetAccountName, type: offsetAccountType, amount: absAmount },
            ],
        }, storeId, client);

        await client.query('COMMIT');

        auditService.log(req.user!, 'Account Balance Adjusted', `Account: ${account.name}, Amount: ${adjustmentAmount}, Reason: ${description}`);
        res.status(200).json({ message: 'Account balance adjusted successfully' });
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
        const storeCreditQuery = `SELECT COALESCE(SUM(store_credit), 0) as "storeCreditValue" FROM customers WHERE store_id = $1`;

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

        // 3. Profit & Loss (Period-bound) — ACCRUAL basis, matching the general ledger.
        // Revenue/COGS are recognised when the sale occurs (all non-cancelled sales),
        // not only when cash is collected. This keeps the Overview, the Reports tab, and
        // the GL in agreement. Cancelled sales are excluded (their GL postings are voided).
        const revenueQuery = `
            SELECT COALESCE(SUM(subtotal - COALESCE(discount, 0)), 0) as revenue
            FROM sales
            WHERE store_id = $1 AND fulfillment_status IS DISTINCT FROM 'cancelled' AND timestamp BETWEEN $2 AND $3
        `;
        // Matching principle: sales carry full cost in their own period; returns
        // to stock reverse cost in the period of the RETURN (same as the GL and
        // /reports/dashboard). Write-offs (not restocked) stay in COGS.
        const cogsQuery = `
            SELECT COALESCE(SUM(si.cost_at_sale * si.quantity), 0) as cogs
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.transaction_id
            WHERE s.store_id = $1 AND s.fulfillment_status IS DISTINCT FROM 'cancelled' AND s.timestamp BETWEEN $2 AND $3
        `;
        const cogsReversalQuery = `
            SELECT COALESCE(SUM(si.cost_at_sale * ri.quantity), 0) as cogs_reversed
            FROM return_items ri
            JOIN returns r ON ri.return_id = r.id AND r.store_id = $1
            JOIN sale_items si ON si.sale_id = r.original_sale_id AND si.product_id = ri.product_id AND si.store_id = $1
            WHERE r.store_id = $1 AND ri.add_to_stock = true AND r.timestamp BETWEEN $2 AND $3
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
            invResult, arResult, apResult, scResult, glResult, revResult, cogsResult, cogsRevResult, expResult, refResult
        ] = await Promise.all([
            db.query(inventoryQuery, [storeId]),
            db.query(arQuery, [storeId]),
            db.query(apQuery, [storeId]),
            db.query(storeCreditQuery, [storeId]),
            db.query(glBalancesQuery, [storeId]),
            db.query(revenueQuery, [storeId, start, adjustedEndDate]),
            db.query(cogsQuery, [storeId, start, adjustedEndDate]),
            db.query(cogsReversalQuery, [storeId, start, adjustedEndDate]),
            db.query(expensesQuery, [storeId, start, adjustedEndDate]),
            db.query(refundsQuery, [storeId, start, adjustedEndDate])
        ]);

        const inventoryValue = parseFloat(invResult.rows[0].inventoryValue);
        const accountsReceivable = parseFloat(arResult.rows[0].accountsReceivable);
        const accountsPayable = parseFloat(apResult.rows[0].accountsPayable);
        const storeCreditValue = parseFloat(scResult.rows[0].storeCreditValue);

        const glBalances = glResult.rows.map(r => ({ ...r, balance: parseFloat(r.balance) }));
        const cashBalance = glBalances.filter(b => b.subType === 'cash').reduce((sum, b) => sum + b.balance, 0);

        const periodGrossSales = parseFloat(revResult.rows[0].revenue);
        const periodRefunds = parseFloat(refResult.rows[0].refunds);
        const periodNetRevenue = periodGrossSales - periodRefunds;
        const periodCogs = parseFloat(cogsResult.rows[0].cogs) - parseFloat(cogsRevResult.rows[0].cogs_reversed);
        const periodExpenses = parseFloat(expResult.rows[0].expenses);
        const periodNetIncome = (periodNetRevenue - periodCogs) - periodExpenses;

        // Total Assets / Liabilities / Equity from GL.
        const totalAssetsGL = glBalances.filter(b => b.type === 'asset').reduce((sum, b) => sum + b.balance, 0);
        const totalLiabilitiesGL = glBalances.filter(b => b.type === 'liability').reduce((sum, b) => sum + b.balance, 0);
        // Equity = contributed capital/equity accounts + retained earnings. The books are
        // not periodically closed, so retained earnings = accumulated (revenue − expenses).
        // With a balanced ledger this makes Assets = Liabilities + Equity hold exactly.
        const equityAccountsGL = glBalances.filter(b => b.type === 'equity').reduce((sum, b) => sum + b.balance, 0);
        const totalRevenueGL = glBalances.filter(b => b.type === 'revenue').reduce((sum, b) => sum + b.balance, 0);
        const totalExpenseGL = glBalances.filter(b => b.type === 'expense').reduce((sum, b) => sum + b.balance, 0);
        const retainedEarnings = totalRevenueGL - totalExpenseGL;
        const totalEquityGL = equityAccountsGL + retainedEarnings;

        // 4. Diagnostic Data
        const missingCostQuery = `SELECT COUNT(*)::int as count FROM products WHERE store_id = $1 AND status = 'active' AND (cost_price IS NULL OR cost_price = 0)`;
        const missingCostResult = await db.query(missingCostQuery, [storeId]);
        const productsMissingCost = missingCostResult.rows[0].count;

        res.status(200).json({
            summary: {
                inventoryValue,
                accountsReceivable,
                accountsPayable,
                storeCreditValue,
                cashBalance,
                totalAssets: totalAssetsGL,
                totalLiabilities: totalLiabilitiesGL,
                equity: totalEquityGL,
                retainedEarnings
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
                inventoryMatch: Math.abs(inventoryValue - (glBalances.find(b => b.subType === 'inventory')?.balance || 0)) < 0.01,
                storeCreditMatch: Math.abs(storeCreditValue - Math.abs(glBalances.find(b => b.subType === 'store_credit_payable')?.balance || 0)) < 0.01,
                hasProductsMissingCost: productsMissingCost > 0,
                productsMissingCostCount: productsMissingCost,
                isTaxRatioSkewed: (periodNetRevenue > 0 && (glBalances.find(b => b.subType === 'sales_tax_payable')?.balance || 0) / periodNetRevenue > 0.4)
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
            LIMIT 1000
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

    const client = await (db as any)._pool.connect();
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const refusal = await refuseManualPosting(storeId, (entryData.lines || []).map(l => l.accountId));
        if (refusal) return res.status(400).json({ message: refusal });

        // Route through the single journal engine so the entry is balance-checked
        // AND account balances are updated — inserting lines directly left the
        // ledger and the account balances permanently out of sync.
        await client.query('BEGIN');
        const entryId = await accountingService.addJournalEntry({
            date: entryData.date,
            description: entryData.description,
            source: { type: 'manual' },
            lines: entryData.lines,
        }, storeId, client);
        await client.query('COMMIT');

        auditService.log(req.user!, 'Manual Journal Entry Created', `Description: ${entryData.description}`);
        res.status(201).json(toCamelCase({ id: entryId, ...entryData }));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating manual entry:', error);
        if ((error as any)?.code === 'BOOKS_LOCKED') return res.status(409).json({ message: (error as any).message, booksLockedUntil: (error as any).lockedUntil });
        res.status(500).json({ message: 'Error creating manual entry' });
    } finally {
        client.release();
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
    const client = await (db as any)._pool.connect();
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        await client.query('BEGIN');

        // Prevent a duplicate invoice for the same PO — that would double-count A/P
        // (an invoice is auto-created when a PO is placed). One invoice per PO.
        if (purchaseOrderId) {
            const dup = await client.query('SELECT id FROM supplier_invoices WHERE purchase_order_id = $1 AND store_id = $2', [purchaseOrderId, storeId]);
            if (dup.rowCount && dup.rowCount > 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({ message: 'An invoice already exists for this purchase order.' });
            }
        }

        const result = await client.query(
            'INSERT INTO supplier_invoices (id, invoice_number, supplier_id, supplier_name, purchase_order_id, po_number, invoice_date, due_date, amount, amount_paid, status, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, \'unpaid\', $10) RETURNING *',
            [id, invoiceNumber, supplierId, supplierName, purchaseOrderId, poNumber, invoiceDate, dueDate, amount, storeId]
        );
        const invoice = toCamelCase(result.rows[0]);

        await accountingService.recordSupplierInvoice(invoice, client, storeId);

        await client.query('COMMIT');
        auditService.log(req.user!, 'Supplier Invoice Created', `Invoice #: ${invoiceNumber} for ${supplierName}`);
        res.status(201).json(invoice);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating supplier invoice:', error);
        res.status(500).json({ message: 'Error creating supplier invoice' });
    } finally {
        client.release();
    }
};
export const updateSupplierInvoice = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { invoiceNumber, supplierId, supplierName, purchaseOrderId, poNumber, invoiceDate, dueDate, amount } = req.body;
    const client = await (db as any)._pool.connect();
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        await client.query('BEGIN');

        // Get old invoice to reverse its journal entry
        const oldInvoiceRes = await client.query('SELECT * FROM supplier_invoices WHERE id = $1 AND store_id = $2', [id, storeId]);
        if (oldInvoiceRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Invoice not found' });
        }
        await accountingService.reverseSupplierInvoice(toCamelCase(oldInvoiceRes.rows[0]), client, storeId);

        const result = await client.query(
            'UPDATE supplier_invoices SET invoice_number=$1, supplier_id=$2, supplier_name=$3, purchase_order_id=$4, po_number=$5, invoice_date=$6, due_date=$7, amount=$8, posted_goods=NULL, posted_other=NULL WHERE id=$9 AND store_id=$10 RETURNING *',
            [invoiceNumber, supplierId, supplierName, purchaseOrderId, poNumber, invoiceDate, dueDate, amount, id, storeId]
        );
        const updatedInvoice = toCamelCase(result.rows[0]);

        await accountingService.recordSupplierInvoice(updatedInvoice, client, storeId);

        await client.query('COMMIT');
        auditService.log(req.user!, 'Supplier Invoice Updated', `Invoice #: ${invoiceNumber}`);
        res.status(200).json(updatedInvoice);
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating supplier invoice:', error);
        res.status(500).json({ message: 'Error updating supplier invoice' });
    } finally {
        client.release();
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
        if ((error as any)?.code === 'BOOKS_LOCKED') return res.status(409).json({ message: (error as any).message, booksLockedUntil: (error as any).lockedUntil });
        console.error('Error recording supplier payment:', error);
        res.status(500).json({ message: 'Error recording supplier payment' });
    } finally {
        client.release();
    }
};
/**
 * POST /accounting/suppliers/:supplierId/payments { amount, method, date?, reference? }
 *
 * One payment to a supplier, spread over their unpaid bills oldest-due first
 * (the way suppliers apply it), so the shop doesn't have to split it by hand.
 * Each bill touched gets its own payment row and journal entry.
 */
export const paySupplier = async (req: express.Request, res: express.Response) => {
    const { supplierId } = req.params;
    const amount = Math.round(Number(req.body?.amount) * 100);
    const method = String(req.body?.method || 'Cash');
    const date = req.body?.date || new Date().toISOString();
    const reference = req.body?.reference || null;
    if (!(amount > 0)) return res.status(400).json({ message: 'Enter an amount to pay.' });

    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
    const client = await (db as any)._pool.connect();
    try {
        await client.query('BEGIN');
        const bills = (await client.query(
            `SELECT * FROM supplier_invoices
              WHERE store_id = $1 AND supplier_id = $2 AND amount - COALESCE(amount_paid, 0) > 0.004
              ORDER BY due_date NULLS LAST, invoice_date, id
              FOR UPDATE`,
            [storeId, supplierId],
        )).rows.map(toCamelCase);
        const owedCents = bills.reduce((s: number, b: any) => s + Math.round(Number(b.amount) * 100) - Math.round(Number(b.amountPaid || 0) * 100), 0);
        if (!bills.length) { await client.query('ROLLBACK'); return res.status(400).json({ message: 'Nothing is owed to this supplier.' }); }
        if (amount > owedCents) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: `That is more than you owe this supplier (${(owedCents / 100).toFixed(2)}).` });
        }

        let left = amount;
        const applied: { invoiceId: string; invoiceNumber: string; amount: number; status: string }[] = [];
        for (const bill of bills) {
            if (left <= 0) break;
            const total = Math.round(Number(bill.amount) * 100);
            const paid = Math.round(Number(bill.amountPaid || 0) * 100);
            const take = Math.min(left, total - paid);
            left -= take;
            const newPaid = paid + take;
            const status = newPaid >= total ? 'paid' : 'partially_paid';
            const paymentId = generateId('spay');
            await client.query(
                'INSERT INTO supplier_payments (id, supplier_invoice_id, date, amount, method, reference, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [paymentId, bill.id, date, take / 100, method, reference, storeId],
            );
            await client.query('UPDATE supplier_invoices SET amount_paid = $1, status = $2 WHERE id = $3 AND store_id = $4', [newPaid / 100, status, bill.id, storeId]);
            await accountingService.recordSupplierPayment(bill, { id: paymentId, supplierInvoiceId: bill.id, date, amount: take / 100, method, reference } as any, client, storeId);
            applied.push({ invoiceId: bill.id, invoiceNumber: bill.invoiceNumber, amount: take / 100, status });
        }
        await client.query('COMMIT');
        auditService.log(req.user!, 'Supplier Payment Recorded', `Supplier ${supplierId}: ${(amount / 100).toFixed(2)} over ${applied.length} bill(s)`);
        res.json({ paid: amount / 100, applied, remainingOwed: (owedCents - amount) / 100 });
    } catch (error) {
        await client.query('ROLLBACK');
        if ((error as any)?.code === 'BOOKS_LOCKED') return res.status(409).json({ message: (error as any).message, booksLockedUntil: (error as any).lockedUntil });
        console.error('Error paying supplier:', error);
        res.status(500).json({ message: 'Error recording supplier payment' });
    } finally {
        client.release();
    }
};
