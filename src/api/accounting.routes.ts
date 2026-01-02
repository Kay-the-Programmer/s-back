import express from 'express';
import {
    getAccounts, createAccount, updateAccount, deleteAccount,
    getJournalEntries, createManualJournalEntry,
    getSupplierInvoices, createSupplierInvoice, updateSupplierInvoice, recordSupplierPayment
} from '../controllers/accounting.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();
router.use(protect, adminOnly);

// Chart of Accounts
router.route('/accounts')
    .get(getAccounts)
    .post(createAccount);
router.route('/accounts/:id')
    .put(updateAccount)
    .delete(deleteAccount);

// Journal Entries
router.route('/journal-entries')
    .get(getJournalEntries)
    .post(createManualJournalEntry);

// Supplier Invoices (Accounts Payable)
router.route('/supplier-invoices')
    .get(getSupplierInvoices)
    .post(createSupplierInvoice);
router.route('/supplier-invoices/:id')
    .put(updateSupplierInvoice);
router.post('/supplier-invoices/:id/payments', recordSupplierPayment);

export default router;