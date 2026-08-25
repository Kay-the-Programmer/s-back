import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { roleHasPermission, Role } from '../auth/rbac';
import { computeTax, toTaxClass } from '../services/tax';

/**
 * Customer quotations and invoices.
 *
 * These are documents, deliberately not a second revenue path: a **sale** stays
 * the only thing that posts revenue, tax and COGS and moves stock (see
 * accounting.service.recordSale). A document records what was offered or
 * billed; when it is acted on it becomes a sale through the normal sales
 * endpoint, and `converted_sale_id` links the two. Nothing here touches the
 * ledger, so the figures in Reports keep their single definition.
 */

type DocType = 'quotation' | 'invoice' | 'delivery_note' | 'receipt';

const DOC_TYPES: DocType[] = ['quotation', 'invoice', 'delivery_note', 'receipt'];

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const PREFIX: Record<DocType, string> = {
    quotation: 'QUO',
    invoice: 'INV',
    delivery_note: 'DN',
    receipt: 'RCP',
};

const DOC_LABEL: Record<DocType, string> = {
    quotation: 'Quotation',
    invoice: 'Invoice',
    delivery_note: 'Delivery Note',
    receipt: 'Receipt',
};

/**
 * A delivery note lists goods handed over, not money — so it carries line items
 * with no prices. A receipt is the mirror image: one amount acknowledged, with
 * no line items at all.
 */
const needsLineItems = (t: DocType) => t !== 'receipt';
const isMoneyDocument = (t: DocType) => t === 'quotation' || t === 'invoice' || t === 'receipt';

/**
 * Status transitions we accept. Anything not listed is rejected, so a document
 * can't be walked into a nonsensical state (e.g. a converted invoice going back
 * to draft, or a declined quote being "accepted" after the fact).
 */
const ALLOWED_TRANSITIONS: Record<string, string[]> = {
    draft: ['sent', 'cancelled'],
    sent: ['accepted', 'declined', 'expired', 'cancelled'],
    accepted: ['converted', 'cancelled'],
    declined: ['sent'],
    expired: ['sent'],
    converted: [],
    cancelled: [],
};

/** Documents may only be edited or deleted while still a draft. */
const isEditable = (status: string) => status === 'draft';

const canManage = (req: express.Request) =>
    roleHasPermission(req.user?.role as Role | undefined, 'sales_docs:manage');

const storeOf = (req: express.Request): string | undefined =>
    (req as any).tenant?.storeId || req.user?.currentStoreId;

interface IncomingItem {
    productId?: string | null;
    name?: string;
    sku?: string | null;
    quantity?: number | string;
    unitPrice?: number | string;
}

/**
 * Validates and normalises the line items, and derives every money figure from
 * them. The client's arithmetic is never trusted — same rule the sales endpoint
 * follows, so a document can't disagree with the sale it becomes.
 */
const buildTotals = (
    items: IncomingItem[],
    discountInput: unknown,
    tax: {
        standardRatePct: number;
        pricesIncludeTax: boolean;
        /** Tax class per catalogue product. A free-text line is standard rated. */
        classes: Map<string, string>;
    },
    /** Delivery notes list goods, not money — a zero unit price is expected. */
    allowZeroPrice = false,
) => {
    const clean = items.map((raw, i) => {
        const quantity = Number(raw.quantity);
        const unitPrice = allowZeroPrice && (raw.unitPrice === undefined || raw.unitPrice === null || raw.unitPrice === '')
            ? 0
            : Number(raw.unitPrice);
        const name = String(raw.name ?? '').trim();
        if (!name) throw new Error(`Line ${i + 1}: a description is required.`);
        if (!Number.isFinite(quantity) || quantity <= 0) {
            throw new Error(`Line ${i + 1}: quantity must be greater than zero.`);
        }
        if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            throw new Error(`Line ${i + 1}: price must be zero or more.`);
        }
        return {
            productId: raw.productId || null,
            name,
            sku: raw.sku || null,
            quantity,
            unitPrice: round2(unitPrice),
            lineTotal: round2(quantity * unitPrice),
            position: i,
        };
    });

    // Taxed through the same engine as the till, so an invoice cannot
    // disagree with the sale it becomes. A line with no catalogue product
    // behind it — a free-text charge — is standard rated.
    const result = computeTax(
        clean.map(i => ({
            price: i.unitPrice,
            quantity: i.quantity,
            taxClass: toTaxClass(i.productId ? tax.classes.get(String(i.productId)) : undefined),
        })),
        Number(discountInput) || 0,
        { standardRatePct: tax.standardRatePct, pricesIncludeTax: tax.pricesIncludeTax },
    );
    return {
        items: clean,
        subtotal: result.subtotal,
        discount: result.discount,
        tax: result.tax,
        total: result.total,
    };
};

const storeTaxRate = async (storeId: string): Promise<number> => {
    const res = await db.query('SELECT tax_rate FROM store_settings WHERE store_id = $1', [storeId]);
    return res.rowCount ? Number(res.rows[0].tax_rate) || 0 : 0;
};

/** The store's standard rate and whether its prices already contain tax. */
const storeTaxConfig = async (
    storeId: string,
): Promise<{ standardRatePct: number; pricesIncludeTax: boolean }> => {
    const res = await db.query(
        'SELECT tax_rate, prices_include_tax FROM store_settings WHERE store_id = $1',
        [storeId],
    );
    return {
        standardRatePct: res.rowCount ? Number(res.rows[0].tax_rate) || 0 : 0,
        pricesIncludeTax: !!res.rows[0]?.prices_include_tax,
    };
};

/**
 * Tax class per product for the catalogue lines on a document.
 *
 * Read from the catalogue rather than taken from the request, for the same
 * reason the till does: a caller that could declare its own class could
 * under-declare the tax on every invoice it raised.
 */
const documentTaxClasses = async (
    items: IncomingItem[],
    storeId: string,
): Promise<Map<string, string>> => {
    const ids = Array.from(new Set((items ?? [])
        .map(i => (i?.productId ? String(i.productId) : ""))
        .filter(Boolean)));
    if (!ids.length) return new Map();
    const { rows } = await db.query(
        `SELECT id, tax_class FROM products WHERE store_id = $1 AND id = ANY($2::text[])`,
        [storeId, ids],
    );
    return new Map(rows.map((r: any) => [String(r.id), String(r.tax_class)]));
};

/**
 * Next number for the store + type, e.g. INV-0007. Computed from the highest
 * existing suffix inside the caller's transaction; the unique index on
 * (store_id, doc_type, number) is the real guard, and the caller retries on a
 * collision, so two people drafting at once can't take the same number.
 */
const nextNumber = async (client: any, storeId: string, docType: DocType): Promise<string> => {
    const res = await client.query(
        `SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '\\D', '', 'g'), '')::int), 0) AS max
         FROM sales_documents WHERE store_id = $1 AND doc_type = $2`,
        [storeId, docType],
    );
    const next = Number(res.rows[0]?.max || 0) + 1;
    return `${PREFIX[docType]}-${String(next).padStart(4, '0')}`;
};

const fetchDocument = async (id: string, storeId: string) => {
    const doc = await db.query(
        'SELECT * FROM sales_documents WHERE id = $1 AND store_id = $2',
        [id, storeId],
    );
    if (doc.rowCount === 0) return null;
    const items = await db.query(
        'SELECT * FROM sales_document_items WHERE document_id = $1 ORDER BY position',
        [id],
    );
    return { ...toCamelCase(doc.rows[0]), items: toCamelCase(items.rows) };
};

// ─────────────────────────────── Reads ───────────────────────────────

export const listDocuments = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });

        const { type, status, customerId, search, limit, offset } = req.query as Record<string, string>;
        const where = ['store_id = $1'];
        const params: any[] = [storeId];

        if (type) { params.push(type); where.push(`doc_type = $${params.length}`); }
        if (status) { params.push(status); where.push(`status = $${params.length}`); }
        if (customerId) { params.push(customerId); where.push(`customer_id = $${params.length}`); }
        if (search) {
            params.push(`%${search}%`);
            where.push(`(number ILIKE $${params.length} OR customer_name ILIKE $${params.length})`);
        }

        const whereSql = `WHERE ${where.join(' AND ')}`;
        const countRes = await db.query(
            `SELECT COUNT(*)::int AS count, COALESCE(SUM(total), 0) AS total_amount
             FROM sales_documents ${whereSql}`,
            params,
        );

        params.push(Math.min(parseInt(limit || '100', 10) || 100, 200));
        params.push(parseInt(offset || '0', 10) || 0);
        const rows = await db.query(
            `SELECT * FROM sales_documents ${whereSql}
             ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
            params,
        );

        res.status(200).json({
            items: toCamelCase(rows.rows),
            totalCount: countRes.rows[0].count,
            totalAmount: Number(countRes.rows[0].total_amount),
        });
    } catch (error) {
        console.error('Error listing sales documents:', error);
        res.status(500).json({ message: 'Error fetching documents' });
    }
};

export const getDocument = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'Store context required' });
        const doc = await fetchDocument(req.params.id, storeId);
        if (!doc) return res.status(404).json({ message: 'Document not found' });
        res.status(200).json(doc);
    } catch (error) {
        console.error('Error fetching sales document:', error);
        res.status(500).json({ message: 'Error fetching document' });
    }
};

// ────────────────────────────── Writes ───────────────────────────────

export const createDocument = async (req: express.Request, res: express.Response) => {
    const {
        docType, customerId, customerName, customerPhone, customerEmail, customerAddress,
        issueDate, validUntil, items, discount, notes, terms, sourceDocumentId,
        amount, paymentMethod, paymentReference, deliveredBy, receivedBy,
    } = req.body as any;

    if (!DOC_TYPES.includes(docType)) {
        return res.status(400).json({ message: `docType must be one of: ${DOC_TYPES.join(', ')}.` });
    }
    if (needsLineItems(docType) && (!Array.isArray(items) || items.length === 0)) {
        return res.status(400).json({ message: 'Add at least one line item.' });
    }
    if (!customerName || !String(customerName).trim()) {
        return res.status(400).json({
            message: docType === 'receipt' ? 'Who the money was received from is required.' : 'A customer name is required.',
        });
    }

    const storeId = storeOf(req);
    if (!storeId) return res.status(400).json({ message: 'Store context required' });

    let totals;
    if (docType === 'receipt') {
        // A receipt acknowledges one figure. There are no lines to derive it
        // from, so it's validated directly rather than through buildTotals.
        const received = Number(amount);
        if (!Number.isFinite(received) || received <= 0) {
            return res.status(400).json({ message: 'Enter the amount received (greater than zero).' });
        }
        totals = { items: [], subtotal: round2(received), discount: 0, tax: 0, total: round2(received) };
    } else {
        try {
            const config = await storeTaxConfig(storeId);
            totals = buildTotals(
                items as IncomingItem[],
                discount,
                {
                    // A delivery note carries no money, so no tax applies to it.
                    standardRatePct: docType === 'delivery_note' ? 0 : config.standardRatePct,
                    pricesIncludeTax: docType !== 'delivery_note' && config.pricesIncludeTax,
                    classes: await documentTaxClasses(items as IncomingItem[], storeId),
                },
                docType === 'delivery_note',
            );
        } catch (e: any) {
            return res.status(400).json({ message: e.message });
        }
    }

    // The customer, when given, must belong to this store.
    if (customerId) {
        const owned = await db.query(
            'SELECT id FROM customers WHERE id = $1 AND store_id = $2',
            [customerId, storeId],
        );
        if (owned.rowCount === 0) {
            return res.status(400).json({ message: 'Unknown customer for this store.' });
        }
    }

    const client = await (db as any)._pool.connect();
    try {
        // Retry the whole insert on a number collision — two people drafting at
        // the same moment would otherwise race for the same sequence value.
        for (let attempt = 0; attempt < 5; attempt++) {
            const id = generateId('sdoc');
            try {
                await client.query('BEGIN');
                const number = await nextNumber(client, storeId, docType);
                const doc = await client.query(
                    `INSERT INTO sales_documents
                        (id, store_id, doc_type, number, status, customer_id, customer_name,
                         customer_phone, customer_email, customer_address, issue_date, valid_until,
                         subtotal, discount, tax, tax_rate, total, notes, terms,
                         source_document_id, created_by, created_by_name,
                         payment_method, payment_reference, delivered_by, received_by,
                         prices_include_tax)
                     VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
                     RETURNING *`,
                    [
                        id, storeId, docType, number, customerId || null, String(customerName).trim(),
                        customerPhone || null, customerEmail || null, customerAddress || null,
                        issueDate || new Date().toISOString().slice(0, 10), validUntil || null,
                        totals.subtotal, totals.discount, totals.tax,
                        docType === 'delivery_note' ? 0 : await storeTaxRate(storeId), totals.total,
                        notes || null, terms || null, sourceDocumentId || null,
                        req.user?.id || 'unknown', req.user?.name || null,
                        paymentMethod || null, paymentReference || null,
                        deliveredBy || null, receivedBy || null,
                        docType !== 'delivery_note' && (await storeTaxConfig(storeId)).pricesIncludeTax,
                    ],
                );

                for (const item of totals.items) {
                    await client.query(
                        `INSERT INTO sales_document_items
                            (id, document_id, store_id, product_id, name, sku, quantity, unit_price, line_total, position)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                        [
                            generateId('sdi'), id, storeId, item.productId, item.name, item.sku,
                            item.quantity, item.unitPrice, item.lineTotal, item.position,
                        ],
                    );
                }

                await client.query('COMMIT');
                auditService.log(req.user!, `${DOC_LABEL[docType as DocType]} Created`,
                    `${number} for ${customerName} — ${totals.total}`);
                const created = await fetchDocument(id, storeId);
                return res.status(201).json(created);
            } catch (e: any) {
                await client.query('ROLLBACK');
                if (e?.code === '23505' && attempt < 4) continue; // number taken; try again
                throw e;
            }
        }
        return res.status(409).json({ message: 'Could not allocate a document number. Try again.' });
    } catch (error) {
        console.error('Error creating sales document:', error);
        res.status(500).json({ message: 'Error creating document' });
    } finally {
        client.release();
    }
};

export const updateDocument = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const {
        customerId, customerName, customerPhone, customerEmail, customerAddress,
        issueDate, validUntil, items, discount, notes, terms,
        amount, paymentMethod, paymentReference, deliveredBy, receivedBy,
    } = req.body as any;

    const storeId = storeOf(req);
    if (!storeId) return res.status(400).json({ message: 'Store context required' });

    const existing = await db.query(
        'SELECT * FROM sales_documents WHERE id = $1 AND store_id = $2',
        [id, storeId],
    );
    if (existing.rowCount === 0) return res.status(404).json({ message: 'Document not found' });

    const row = existing.rows[0];
    // An issued document is a record of what the customer was given. Changing
    // it after the fact is an admin action, and never once it became a sale.
    if (row.status === 'converted') {
        return res.status(409).json({ message: 'This document has been converted to a sale and can no longer be edited.' });
    }
    if (!isEditable(row.status) && !canManage(req)) {
        return res.status(403).json({ message: 'Only a draft can be edited. Ask an admin to amend an issued document.' });
    }
    const docType = row.doc_type as DocType;
    if (needsLineItems(docType) && (!Array.isArray(items) || items.length === 0)) {
        return res.status(400).json({ message: 'Add at least one line item.' });
    }

    let totals;
    if (docType === 'receipt') {
        const received = Number(amount ?? row.total);
        if (!Number.isFinite(received) || received <= 0) {
            return res.status(400).json({ message: 'Enter the amount received (greater than zero).' });
        }
        totals = { items: [], subtotal: round2(received), discount: 0, tax: 0, total: round2(received) };
    } else {
        try {
            totals = buildTotals(
                items as IncomingItem[],
                discount,
                {
                    // The rate and mode the document was issued under, not
                    // today's: editing an invoice must not silently reprice it
                    // because the store changed its tax settings since.
                    standardRatePct: Number(row.tax_rate) || 0,
                    pricesIncludeTax: !!row.prices_include_tax,
                    classes: await documentTaxClasses(items as IncomingItem[], storeId),
                },
                docType === 'delivery_note',
            );
        } catch (e: any) {
            return res.status(400).json({ message: e.message });
        }
    }

    const client = await (db as any)._pool.connect();
    try {
        await client.query('BEGIN');
        await client.query(
            `UPDATE sales_documents SET
                customer_id = $1, customer_name = $2, customer_phone = $3, customer_email = $4,
                customer_address = $5, issue_date = $6, valid_until = $7, subtotal = $8,
                discount = $9, tax = $10, total = $11, notes = $12, terms = $13,
                payment_method = $16, payment_reference = $17, delivered_by = $18, received_by = $19,
                updated_at = NOW()
             WHERE id = $14 AND store_id = $15`,
            [
                customerId || null, String(customerName || row.customer_name).trim(),
                customerPhone || null, customerEmail || null, customerAddress || null,
                issueDate || row.issue_date, validUntil || null,
                totals.subtotal, totals.discount, totals.tax, totals.total,
                notes || null, terms || null, id, storeId,
                paymentMethod ?? row.payment_method, paymentReference ?? row.payment_reference,
                deliveredBy ?? row.delivered_by, receivedBy ?? row.received_by,
            ],
        );
        await client.query('DELETE FROM sales_document_items WHERE document_id = $1', [id]);
        for (const item of totals.items) {
            await client.query(
                `INSERT INTO sales_document_items
                    (id, document_id, store_id, product_id, name, sku, quantity, unit_price, line_total, position)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [
                    generateId('sdi'), id, storeId, item.productId, item.name, item.sku,
                    item.quantity, item.unitPrice, item.lineTotal, item.position,
                ],
            );
        }
        await client.query('COMMIT');
        auditService.log(req.user!, 'Sales Document Updated', `${row.number} — ${totals.total}`);
        res.status(200).json(await fetchDocument(id, storeId));
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating sales document:', error);
        res.status(500).json({ message: 'Error updating document' });
    } finally {
        client.release();
    }
};

export const updateStatus = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { status } = req.body as { status?: string };
    const storeId = storeOf(req);
    if (!storeId) return res.status(400).json({ message: 'Store context required' });

    try {
        const existing = await db.query(
            'SELECT * FROM sales_documents WHERE id = $1 AND store_id = $2',
            [id, storeId],
        );
        if (existing.rowCount === 0) return res.status(404).json({ message: 'Document not found' });

        const from = existing.rows[0].status as string;
        const allowed = ALLOWED_TRANSITIONS[from] || [];
        if (!status || !allowed.includes(status)) {
            return res.status(400).json({
                message: `Cannot move a ${from} document to "${status}".`,
                allowed,
            });
        }
        // 'converted' is only ever set by the conversion endpoint, which has the
        // sale id to record alongside it.
        if (status === 'converted') {
            return res.status(400).json({ message: 'Use the conversion endpoint to mark a document converted.' });
        }

        const updated = await db.query(
            'UPDATE sales_documents SET status = $1, updated_at = NOW() WHERE id = $2 AND store_id = $3 RETURNING *',
            [status, id, storeId],
        );
        auditService.log(req.user!, 'Sales Document Status Changed',
            `${existing.rows[0].number}: ${from} → ${status}`);
        res.status(200).json(toCamelCase(updated.rows[0]));
    } catch (error) {
        console.error('Error updating document status:', error);
        res.status(500).json({ message: 'Error updating status' });
    }
};

/**
 * Quotation → invoice. Copies the accepted quote into a new invoice document
 * and marks the quote converted, keeping the paper trail in both directions
 * (`source_document_id` on the invoice).
 */
export const convertToInvoice = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { dueDate } = req.body as { dueDate?: string };
    const storeId = storeOf(req);
    if (!storeId) return res.status(400).json({ message: 'Store context required' });

    const client = await (db as any)._pool.connect();
    try {
        const source = await fetchDocument(id, storeId);
        if (!source) return res.status(404).json({ message: 'Document not found' });
        if (source.docType !== 'quotation') {
            return res.status(400).json({ message: 'Only a quotation can be converted to an invoice.' });
        }
        if (source.status === 'converted') {
            return res.status(409).json({ message: 'This quotation has already been converted.' });
        }
        if (source.status === 'cancelled' || source.status === 'declined') {
            return res.status(409).json({ message: `A ${source.status} quotation cannot be converted.` });
        }

        for (let attempt = 0; attempt < 5; attempt++) {
            const invoiceId = generateId('sdoc');
            try {
                await client.query('BEGIN');
                const number = await nextNumber(client, storeId, 'invoice');
                await client.query(
                    `INSERT INTO sales_documents
                        (id, store_id, doc_type, number, status, customer_id, customer_name,
                         customer_phone, customer_email, customer_address, issue_date, valid_until,
                         subtotal, discount, tax, tax_rate, total, notes, terms,
                         source_document_id, created_by, created_by_name)
                     VALUES ($1,$2,'invoice',$3,'draft',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
                    [
                        invoiceId, storeId, number, source.customerId, source.customerName,
                        source.customerPhone, source.customerEmail, source.customerAddress,
                        new Date().toISOString().slice(0, 10), dueDate || null,
                        source.subtotal, source.discount, source.tax, source.taxRate, source.total,
                        source.notes, source.terms, source.id,
                        req.user?.id || 'unknown', req.user?.name || null,
                    ],
                );
                for (const item of source.items as any[]) {
                    await client.query(
                        `INSERT INTO sales_document_items
                            (id, document_id, store_id, product_id, name, sku, quantity, unit_price, line_total, position)
                         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                        [
                            generateId('sdi'), invoiceId, storeId, item.productId, item.name, item.sku,
                            item.quantity, item.unitPrice, item.lineTotal, item.position,
                        ],
                    );
                }
                await client.query(
                    `UPDATE sales_documents SET status = 'converted', converted_at = NOW(), updated_at = NOW()
                     WHERE id = $1 AND store_id = $2`,
                    [id, storeId],
                );
                await client.query('COMMIT');
                auditService.log(req.user!, 'Quotation Converted', `${source.number} → ${number}`);
                return res.status(201).json(await fetchDocument(invoiceId, storeId));
            } catch (e: any) {
                await client.query('ROLLBACK');
                if (e?.code === '23505' && attempt < 4) continue;
                throw e;
            }
        }
        return res.status(409).json({ message: 'Could not allocate an invoice number. Try again.' });
    } catch (error) {
        console.error('Error converting quotation:', error);
        res.status(500).json({ message: 'Error converting document' });
    } finally {
        client.release();
    }
};

/**
 * Records that a document became a sale.
 *
 * The client posts the sale through the normal `/sales` endpoint — the one
 * place stock, revenue, tax and COGS are handled — and then calls this to link
 * the two. The sale is verified to exist in this store first, so a document
 * can't be marked converted against a sale that never landed. Safe to repeat:
 * calling it again with the same sale is a no-op, which is what makes the
 * two-step conversion retryable if the browser dies in between.
 */
export const linkSale = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const { saleId } = req.body as { saleId?: string };
    const storeId = storeOf(req);
    if (!storeId) return res.status(400).json({ message: 'Store context required' });
    if (!saleId) return res.status(400).json({ message: 'saleId is required.' });

    try {
        const existing = await db.query(
            'SELECT * FROM sales_documents WHERE id = $1 AND store_id = $2',
            [id, storeId],
        );
        if (existing.rowCount === 0) return res.status(404).json({ message: 'Document not found' });

        const row = existing.rows[0];
        if (row.converted_sale_id && row.converted_sale_id !== saleId) {
            return res.status(409).json({
                message: 'This document is already linked to a different sale.',
                saleId: row.converted_sale_id,
            });
        }

        const sale = await db.query(
            'SELECT transaction_id FROM sales WHERE transaction_id = $1 AND store_id = $2',
            [saleId, storeId],
        );
        if (sale.rowCount === 0) {
            return res.status(400).json({ message: 'That sale does not exist in this store.' });
        }

        const updated = await db.query(
            `UPDATE sales_documents
             SET status = 'converted', converted_sale_id = $1, converted_at = NOW(), updated_at = NOW()
             WHERE id = $2 AND store_id = $3 RETURNING *`,
            [saleId, id, storeId],
        );
        if (row.converted_sale_id !== saleId) {
            auditService.log(req.user!, 'Sales Document Converted', `${row.number} → sale ${saleId}`);
        }
        res.status(200).json(toCamelCase(updated.rows[0]));
    } catch (error) {
        console.error('Error linking sale to document:', error);
        res.status(500).json({ message: 'Error linking sale' });
    }
};

export const deleteDocument = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    const storeId = storeOf(req);
    if (!storeId) return res.status(400).json({ message: 'Store context required' });

    try {
        const existing = await db.query(
            'SELECT * FROM sales_documents WHERE id = $1 AND store_id = $2',
            [id, storeId],
        );
        if (existing.rowCount === 0) return res.status(404).json({ message: 'Document not found' });
        if (existing.rows[0].status === 'converted') {
            return res.status(409).json({ message: 'A document that became a sale cannot be deleted. Cancel it instead.' });
        }
        // Items go with it (ON DELETE CASCADE).
        await db.query('DELETE FROM sales_documents WHERE id = $1 AND store_id = $2', [id, storeId]);
        auditService.log(req.user!, 'Sales Document Deleted', `${existing.rows[0].number}`);
        res.status(200).json({ message: 'Document deleted' });
    } catch (error) {
        console.error('Error deleting sales document:', error);
        res.status(500).json({ message: 'Error deleting document' });
    }
};
