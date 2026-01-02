import express from 'express';
import db from '../db_client';
import { Account, JournalEntry, SupplierInvoice, SupplierPayment } from '../types';
import {generateId, toCamelCase} from '../utils/helpers';
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
        if(result.rowCount === 0) return res.status(404).json({ message: 'Invoice not found' });
        auditService.log(req.user!, 'Supplier Invoice Updated', `Invoice #: ${invoiceNumber}`);
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        res.status(500).json({ message: 'Error updating supplier invoice' });
    }
};
export const recordSupplierPayment = async (req: express.Request, res: express.Response) => {
    const { id: invoiceId } = req.params;
    const paymentData: Omit<SupplierPayment, 'id'> = req.body;
    try {
        const invoiceRes = await db.query('SELECT amount, amount_paid FROM supplier_invoices WHERE id = $1', [invoiceId]);
        if (invoiceRes.rowCount === 0) return res.status(404).json({ message: 'Invoice not found' });

        const invoice = invoiceRes.rows[0];

        // Work in cents to avoid floating point rounding errors
        const amountCents = Math.round(invoice.amount * 100);
        const paidCents = Math.round(invoice.amount_paid * 100);
        const remainingCents = Math.max(0, amountCents - paidCents);
        const paymentCents = Math.round(paymentData.amount * 100);

        // Block payments when invoice is already fully paid
        if (remainingCents <= 0) {
            return res.status(400).json({ message: 'Invoice is already fully paid. No additional payments are allowed.' });
        }
        // Prevent overpayments beyond the remaining balance
        if (paymentCents > remainingCents) {
            return res.status(400).json({ message: `Payment exceeds remaining balance. Remaining due is ${(remainingCents/100).toFixed(2)}.` });
        }

        const newPaidCents = paidCents + paymentCents;
        const newStatus: SupplierInvoice['status'] = newPaidCents >= amountCents ? 'paid' : 'partially_paid';
        const newAmountPaid = newPaidCents / 100;

        await db.query(
            'INSERT INTO supplier_payments (id, supplier_invoice_id, date, amount, method, reference) VALUES ($1, $2, $3, $4, $5, $6)',
            [generateId('spay'), invoiceId, paymentData.date, paymentData.amount, paymentData.method, paymentData.reference]
        );

        const updatedInvoice = await db.query(
            'UPDATE supplier_invoices SET amount_paid = $1, status = $2 WHERE id = $3 RETURNING *',
            [newAmountPaid, newStatus, invoiceId]
        );

        auditService.log(req.user!, 'Supplier Payment Recorded', `For Invoice ID: ${invoiceId}, Amount: ${paymentData.amount.toFixed(2)}`);
        res.status(200).json(toCamelCase(updatedInvoice.rows[0]));
    } catch (error) {
        res.status(500).json({ message: 'Error recording supplier payment' });
    }
};