import express from 'express';
import {
    getAccounts, createAccount, updateAccount, deleteAccount, adjustAccountBalance,
    getJournalEntries, createManualJournalEntry,
    getSupplierInvoices, createSupplierInvoice, updateSupplierInvoice, recordSupplierPayment,
    getFinancialOverview
} from '../controllers/accounting.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();
router.use(protect, adminOnly);

/**
 * @openapi
 * /accounting/summary:
 *   get:
 *     tags: [Accounting]
 *     summary: Get financial overview/summary
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Financial summary
 */
router.get('/summary', getFinancialOverview);

/**
 * @openapi
 * /accounting/accounts:
 *   get:
 *     tags: [Accounting]
 *     summary: Get chart of accounts
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of accounts
 *   post:
 *     tags: [Accounting]
 *     summary: Create a new account
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               number: { type: string }
 *               type: { type: string, enum: [asset, liability, equity, revenue, expense] }
 */
router.route('/accounts')
    .get(getAccounts)
    .post(createAccount);

/**
 * @openapi
 * /accounting/accounts/{id}:
 *   put:
 *     tags: [Accounting]
 *     summary: Update an account
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   delete:
 *     tags: [Accounting]
 *     summary: Delete an account
 *     security:
 *       - bearerAuth: []
 */
router.route('/accounts/:id')
    .put(updateAccount)
    .delete(deleteAccount);

/**
 * @openapi
 * /accounting/accounts/{id}/adjust:
 *   post:
 *     tags: [Accounting]
 *     summary: Manually adjust an account balance
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/accounts/:id/adjust', adjustAccountBalance);

/**
 * @openapi
 * /accounting/journal-entries:
 *   get:
 *     tags: [Accounting]
 *     summary: Get all journal entries
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Accounting]
 *     summary: Create a manual journal entry
 *     security:
 *       - bearerAuth: []
 */
router.route('/journal-entries')
    .get(getJournalEntries)
    .post(createManualJournalEntry);

/**
 * @openapi
 * /accounting/supplier-invoices:
 *   get:
 *     tags: [Accounting]
 *     summary: Get all supplier invoices (Accounts Payable)
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Accounting]
 *     summary: Create a supplier invoice
 *     security:
 *       - bearerAuth: []
 */
router.route('/supplier-invoices')
    .get(getSupplierInvoices)
    .post(createSupplierInvoice);

/**
 * @openapi
 * /accounting/supplier-invoices/{id}:
 *   put:
 *     tags: [Accounting]
 *     summary: Update a supplier invoice
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.route('/supplier-invoices/:id')
    .put(updateSupplierInvoice);

/**
 * @openapi
 * /accounting/supplier-invoices/{id}/payments:
 *   post:
 *     tags: [Accounting]
 *     summary: Record a payment for a supplier invoice
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/supplier-invoices/:id/payments', recordSupplierPayment);

export default router;