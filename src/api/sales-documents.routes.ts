import express from 'express';
import {
    listDocuments,
    getDocument,
    createDocument,
    updateDocument,
    updateStatus,
    convertToInvoice,
    linkSale,
    deleteDocument,
} from '../controllers/sales-documents.controller';
import { protect } from '../middleware/auth.middleware';
import { requirePermission, requireAnyPermission } from '../auth/rbac';

const router = express.Router();
router.use(protect);

/**
 * Quotations & invoices.
 *
 *   `sales_docs:create` (staff) — draft, issue, convert.
 *   `sales_docs:manage` (admin) — the above plus editing an issued document
 *                                 and deleting one.
 */
const canCreate = requireAnyPermission('sales_docs:create', 'sales_docs:manage');
const canManage = requirePermission('sales_docs:manage');

/**
 * @openapi
 * /sales-documents:
 *   get:
 *     tags: [Sales Documents]
 *     summary: List quotations and invoices
 *     parameters:
 *       - in: query
 *         name: type
 *         schema: { type: string, enum: [quotation, invoice] }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     tags: [Sales Documents]
 *     summary: Create a quotation or invoice (draft)
 *     security: [{ bearerAuth: [] }]
 */
router.route('/')
    .get(canCreate, listDocuments)
    .post(canCreate, createDocument);

/**
 * @openapi
 * /sales-documents/{id}:
 *   get:
 *     tags: [Sales Documents]
 *     summary: Get one document with its line items
 *     security: [{ bearerAuth: [] }]
 *   put:
 *     tags: [Sales Documents]
 *     summary: Update a draft document
 *     security: [{ bearerAuth: [] }]
 *   delete:
 *     tags: [Sales Documents]
 *     summary: Delete a document (admin; never one that became a sale)
 *     security: [{ bearerAuth: [] }]
 */
router.route('/:id')
    .get(canCreate, getDocument)
    .put(canCreate, updateDocument)
    .delete(canManage, deleteDocument);

/**
 * @openapi
 * /sales-documents/{id}/status:
 *   patch:
 *     tags: [Sales Documents]
 *     summary: Move a document through its lifecycle (sent, accepted, declined…)
 *     security: [{ bearerAuth: [] }]
 */
router.patch('/:id/status', canCreate, updateStatus);

/**
 * @openapi
 * /sales-documents/{id}/convert-to-invoice:
 *   post:
 *     tags: [Sales Documents]
 *     summary: Copy an accepted quotation into a new invoice
 *     security: [{ bearerAuth: [] }]
 */
router.post('/:id/convert-to-invoice', canCreate, convertToInvoice);

/**
 * @openapi
 * /sales-documents/{id}/link-sale:
 *   post:
 *     tags: [Sales Documents]
 *     summary: Link the sale this document became
 *     description: >
 *       The sale itself is created through POST /sales — the single place stock
 *       and the ledger are touched. This records the link and marks the
 *       document converted.
 *     security: [{ bearerAuth: [] }]
 */
router.post('/:id/link-sale', canCreate, linkSale);

export default router;
