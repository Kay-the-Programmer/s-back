/**
 * Customer quotations & invoices, end-to-end against the local backend.
 *
 * The design rule this suite defends: a document is *not* a second revenue
 * path. Creating or issuing a quote/invoice must leave the ledger and stock
 * completely untouched; only the sale it becomes moves those. What's pinned:
 *  1. Staff can draft, issue and convert; totals are computed server-side.
 *  2. Numbering is sequential per store and per type, and unique.
 *  3. Status transitions are validated — no nonsensical jumps.
 *  4. An issued document can't be silently edited; a converted one is frozen.
 *  5. Quotation → invoice copies the lines and links both ways.
 *  6. Linking a sale is verified and idempotent (retry-safe).
 *  7. Nothing touches the journal or stock until the sale is made.
 *  8. Tenant isolation: another store's document is invisible.
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { randomUUID } from 'crypto';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `docstest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const OTHER_STORE_ID = `store-other-${RUN}`;
const ADMIN_ID = `user-admin-${RUN}`;
const STAFF_ID = `user-staff-${RUN}`;
const OTHER_ADMIN_ID = `user-other-${RUN}`;
const PRODUCT_ID = `prod-${RUN}`;
const CUSTOMER_ID = `cust-${RUN}`;
const FOREIGN_CUSTOMER_ID = `cust-foreign-${RUN}`;
const PASSWORD = 'docstest-password-1';

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const req = async (method, path, body, headers = {}) => {
    const r = await fetch(API + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
};

const db = new pg.Client({ connectionString: DATABASE_URL });

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    for (const [id, name] of [[STORE_ID, `Docs Store ${RUN}`], [OTHER_STORE_ID, `Other Docs Store ${RUN}`]]) {
        await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1,$2,'active','active')`, [id, name]);
        await db.query(
            `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit)
             VALUES ($1,$2,16,'{"symbol":"K","code":"ZMW","position":"before"}'::jsonb,5,true)`,
            [id, name],
        );
    }
    for (const [id, name, email, role, storeId] of [
        [ADMIN_ID, 'Docs Owner', `admin-${RUN}@test.local`, 'admin', STORE_ID],
        [STAFF_ID, 'Docs Cashier', `staff-${RUN}@test.local`, 'staff', STORE_ID],
        [OTHER_ADMIN_ID, 'Other Owner', `other-${RUN}@test.local`, 'admin', OTHER_STORE_ID],
    ]) {
        await db.query(
            `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
             VALUES ($1,$2,$3,$4,$5,$6,true)`,
            [id, name, email, hash, role, storeId],
        );
    }
    await db.query(
        `INSERT INTO products (id, name, description, sku, price, cost_price, stock, status, store_id, image_urls)
         VALUES ($1,'Docs Widget','doc test',$2,150.00,90.00,40,'active',$3,'{}')`,
        [PRODUCT_ID, `DOC-${RUN}`, STORE_ID],
    );
    await db.query(`INSERT INTO customers (id, name, phone, store_id) VALUES ($1,'Doc Customer','0977000111',$2)`, [CUSTOMER_ID, STORE_ID]);
    await db.query(`INSERT INTO customers (id, name, phone, store_id) VALUES ($1,'Foreign Customer','0977000222',$2)`, [FOREIGN_CUSTOMER_ID, OTHER_STORE_ID]);
};

const cleanup = async () => {
    for (const storeId of [STORE_ID, OTHER_STORE_ID]) {
        for (const q of [
            [`DELETE FROM sales_document_items WHERE store_id = $1`, [storeId]],
            [`DELETE FROM sales_documents WHERE store_id = $1`, [storeId]],
            [`DELETE FROM idempotency_keys WHERE key LIKE $1`, [`%${RUN}%`]],
            [`DELETE FROM journal_entry_lines WHERE store_id = $1`, [storeId]],
            [`DELETE FROM journal_entries WHERE store_id = $1`, [storeId]],
            [`DELETE FROM payments WHERE store_id = $1`, [storeId]],
            [`DELETE FROM sale_items WHERE store_id = $1`, [storeId]],
            [`DELETE FROM sales WHERE store_id = $1`, [storeId]],
            [`DELETE FROM audit_logs WHERE store_id = $1`, [storeId]],
            [`DELETE FROM products WHERE store_id = $1`, [storeId]],
            [`DELETE FROM customers WHERE store_id = $1`, [storeId]],
            [`DELETE FROM store_settings WHERE store_id = $1`, [storeId]],
            [`DELETE FROM users WHERE current_store_id = $1`, [storeId]],
            [`DELETE FROM stores WHERE id = $1`, [storeId]],
        ]) {
            try { await db.query(q[0], q[1]); } catch { /* table may not exist */ }
        }
    }
};

const login = async (email) => {
    const r = await req('POST', '/auth/login', { email, password: PASSWORD });
    if (r.status !== 200 || !r.data?.token) throw new Error(`login failed for ${email}: ${r.status}`);
    return { Authorization: `Bearer ${r.data.token}` };
};

const lineItems = () => ([
    { productId: PRODUCT_ID, name: 'Docs Widget', sku: `DOC-${RUN}`, quantity: 2, unitPrice: 150 },
    { name: 'Delivery to site', quantity: 1, unitPrice: 50 },
]);

const ledgerAndStock = async () => {
    const j = await db.query('SELECT COUNT(*)::int AS n FROM journal_entries WHERE store_id = $1', [STORE_ID]);
    const s = await db.query('SELECT stock FROM products WHERE id = $1', [PRODUCT_ID]);
    return { journals: j.rows[0].n, stock: Number(s.rows[0].stock) };
};

const run = async () => {
    await db.connect();
    await cleanup();
    await seed();

    const admin = await login(`admin-${RUN}@test.local`);
    const staff = await login(`staff-${RUN}@test.local`);
    const other = await login(`other-${RUN}@test.local`);

    const before = await ledgerAndStock();

    // 1. Draft a quotation as staff.
    const quote = await req('POST', '/sales-documents', {
        docType: 'quotation',
        customerId: CUSTOMER_ID,
        customerName: 'Doc Customer',
        items: lineItems(),
        discount: 50,
        validUntil: '2026-12-31',
        notes: 'Valid for 30 days',
    }, staff);
    check('staff can draft a quotation', quote.status === 201, `status ${quote.status} ${JSON.stringify(quote.data).slice(0, 140)}`);
    const quoteId = quote.data?.id;
    check('quotation gets a sequential number', quote.data?.number === 'QUO-0001', quote.data?.number);
    check('it starts as a draft', quote.data?.status === 'draft', quote.data?.status);

    // 2. Totals are the server's, not the client's.
    // 2×150 + 50 = 350 subtotal, −50 discount = 300, +16% tax = 48 → 348.
    check(
        'totals are computed server-side from the line items',
        Number(quote.data?.subtotal) === 350 && Number(quote.data?.discount) === 50 &&
        Number(quote.data?.tax) === 48 && Number(quote.data?.total) === 348,
        `sub ${quote.data?.subtotal} disc ${quote.data?.discount} tax ${quote.data?.tax} total ${quote.data?.total}`,
    );
    check('line items are stored in order', (quote.data?.items || []).length === 2 &&
        quote.data.items[0].name === 'Docs Widget' && Number(quote.data.items[0].lineTotal) === 300);

    // A free-text line needs no product — that's the point of a quotation.
    check('a line item without a product is allowed', quote.data?.items?.[1]?.productId == null);

    // 3. Bad input is rejected.
    const noItems = await req('POST', '/sales-documents', {
        docType: 'quotation', customerName: 'X', items: [],
    }, staff);
    check('a document with no lines is rejected', noItems.status === 400, `status ${noItems.status}`);
    const badQty = await req('POST', '/sales-documents', {
        docType: 'invoice', customerName: 'X',
        items: [{ name: 'Bad', quantity: 0, unitPrice: 10 }],
    }, staff);
    check('a zero quantity is rejected', badQty.status === 400, badQty.data?.message);
    const badType = await req('POST', '/sales-documents', {
        docType: 'receipt', customerName: 'X', items: lineItems(),
    }, staff);
    check('an unknown document type is rejected', badType.status === 400);
    const foreignCustomer = await req('POST', '/sales-documents', {
        docType: 'quotation', customerId: FOREIGN_CUSTOMER_ID, customerName: 'Foreign', items: lineItems(),
    }, staff);
    check("another store's customer is rejected", foreignCustomer.status === 400, foreignCustomer.data?.message);

    // 4. Lifecycle.
    const badJump = await req('PATCH', `/sales-documents/${quoteId}/status`, { status: 'accepted' }, staff);
    check('a draft cannot jump straight to accepted', badJump.status === 400, badJump.data?.message);
    const sent = await req('PATCH', `/sales-documents/${quoteId}/status`, { status: 'sent' }, staff);
    check('a draft can be marked sent', sent.status === 200 && sent.data?.status === 'sent', sent.data?.status);
    const accepted = await req('PATCH', `/sales-documents/${quoteId}/status`, { status: 'accepted' }, staff);
    check('a sent quotation can be accepted', accepted.status === 200 && accepted.data?.status === 'accepted');
    const sneak = await req('PATCH', `/sales-documents/${quoteId}/status`, { status: 'converted' }, staff);
    check('conversion cannot be faked through the status endpoint', sneak.status === 400);

    // 5. Editing rules.
    const staffEdit = await req('PUT', `/sales-documents/${quoteId}`, {
        customerName: 'Doc Customer', items: lineItems(), discount: 0,
    }, staff);
    check('staff cannot edit an issued document', staffEdit.status === 403, `status ${staffEdit.status}`);
    const adminEdit = await req('PUT', `/sales-documents/${quoteId}`, {
        customerName: 'Doc Customer', items: lineItems(), discount: 0,
    }, admin);
    check('an admin can amend an issued document', adminEdit.status === 200 && Number(adminEdit.data?.total) === 406,
        `total ${adminEdit.data?.total}`);

    // 6. Quotation → invoice.
    const invoice = await req('POST', `/sales-documents/${quoteId}/convert-to-invoice`, { dueDate: '2026-09-30' }, staff);
    check('an accepted quotation converts to an invoice', invoice.status === 201, `status ${invoice.status} ${JSON.stringify(invoice.data).slice(0, 120)}`);
    const invoiceId = invoice.data?.id;
    check('the invoice gets its own number series', invoice.data?.number === 'INV-0001', invoice.data?.number);
    check('the invoice carries the quotation lines and totals',
        (invoice.data?.items || []).length === 2 && Number(invoice.data?.total) === 406,
        `total ${invoice.data?.total}`);
    check('the invoice points back at the quotation', invoice.data?.sourceDocumentId === quoteId);

    const quoteAfter = await req('GET', `/sales-documents/${quoteId}`, null, staff);
    check('the quotation is marked converted', quoteAfter.data?.status === 'converted', quoteAfter.data?.status);
    const reconvert = await req('POST', `/sales-documents/${quoteId}/convert-to-invoice`, {}, staff);
    check('a converted quotation cannot be converted twice', reconvert.status === 409, `status ${reconvert.status}`);

    // 7. Nothing has touched the books or stock yet.
    const mid = await ledgerAndStock();
    check(
        'no journal entry and no stock movement from documents alone',
        mid.journals === before.journals && mid.stock === before.stock,
        `journals ${before.journals}→${mid.journals}, stock ${before.stock}→${mid.stock}`,
    );

    // 8. The sale — made through the normal endpoint — then linked.
    const transactionId = randomUUID();
    const sale = await req('POST', '/sales', {
        transactionId,
        timestamp: new Date().toISOString(),
        cart: [{ productId: PRODUCT_ID, name: 'Docs Widget', sku: `DOC-${RUN}`, price: 150, quantity: 2 }],
        subtotal: 300, tax: 48, discount: 0, total: 348, amountPaid: 348,
        paymentStatus: 'paid', customerId: CUSTOMER_ID,
    }, staff, );
    check('the sale itself goes through the normal sales endpoint', sale.status === 201, `status ${sale.status} ${JSON.stringify(sale.data).slice(0, 120)}`);

    const link = await req('POST', `/sales-documents/${invoiceId}/link-sale`, { saleId: transactionId }, staff);
    check('the invoice links to the sale', link.status === 200 && link.data?.status === 'converted', `status ${link.status}`);
    const linkAgain = await req('POST', `/sales-documents/${invoiceId}/link-sale`, { saleId: transactionId }, staff);
    check('linking the same sale again is safe (retryable)', linkAgain.status === 200, `status ${linkAgain.status}`);
    const linkOther = await req('POST', `/sales-documents/${invoiceId}/link-sale`, { saleId: randomUUID() }, staff);
    check('linking a different sale is refused', linkOther.status === 409 || linkOther.status === 400, `status ${linkOther.status}`);
    const bogus = await req('POST', `/sales-documents/${quoteId}/link-sale`, { saleId: 'sale-that-does-not-exist' }, admin);
    check('a sale that does not exist cannot be linked', bogus.status === 400, `status ${bogus.status}`);

    // Now the ledger and stock have moved — because of the sale, not the document.
    const after = await ledgerAndStock();
    check(
        'the sale is what moved stock and the ledger',
        after.journals > mid.journals && after.stock === before.stock - 2,
        `journals ${mid.journals}→${after.journals}, stock ${mid.stock}→${after.stock}`,
    );

    const frozen = await req('PUT', `/sales-documents/${invoiceId}`, {
        customerName: 'Changed', items: lineItems(), discount: 0,
    }, admin);
    check('a converted document is frozen even for an admin', frozen.status === 409, `status ${frozen.status}`);
    const delConverted = await req('DELETE', `/sales-documents/${invoiceId}`, null, admin);
    check('a converted document cannot be deleted', delConverted.status === 409, `status ${delConverted.status}`);

    // 9. Numbering continues, and deletion is admin-only.
    const second = await req('POST', '/sales-documents', {
        docType: 'quotation', customerName: 'Walk-in', items: [{ name: 'Consulting', quantity: 1, unitPrice: 500 }],
    }, staff);
    check('numbering continues from the last document', second.data?.number === 'QUO-0002', second.data?.number);
    const staffDelete = await req('DELETE', `/sales-documents/${second.data?.id}`, null, staff);
    check('staff cannot delete a document', staffDelete.status === 403, `status ${staffDelete.status}`);
    const adminDelete = await req('DELETE', `/sales-documents/${second.data?.id}`, null, admin);
    check('an admin can delete a draft', adminDelete.status === 200, `status ${adminDelete.status}`);
    const itemsGone = await db.query('SELECT COUNT(*)::int AS n FROM sales_document_items WHERE document_id = $1', [second.data?.id]);
    check('its line items go with it', itemsGone.rows[0].n === 0);

    // 10. Tenant isolation.
    const peek = await req('GET', `/sales-documents/${invoiceId}`, null, other);
    check("another store cannot read this store's document", peek.status === 404, `status ${peek.status}`);
    const otherList = await req('GET', '/sales-documents', null, other);
    check("another store's list is empty", (otherList.data?.items ?? []).length === 0);

    // 11. Listing and filtering.
    const list = await req('GET', '/sales-documents?type=invoice', null, admin);
    check('documents can be filtered by type', (list.data?.items ?? []).every(d => d.docType === 'invoice') &&
        (list.data?.items ?? []).length === 1, `${(list.data?.items ?? []).length} invoice(s)`);

    // ── 12. Manual delivery notes ──────────────────────────────────────────
    // Goods handed over: quantities and descriptions, no money, signed for.
    const ledgerBeforeManual = await ledgerAndStock();
    const dn = await req('POST', '/sales-documents', {
        docType: 'delivery_note',
        customerName: 'Doc Customer',
        customerAddress: 'Plot 12, Lusaka',
        items: [
            { name: 'Office Desk', quantity: 3 },
            { name: 'Visitor Chair', quantity: 6, unitPrice: '' },
        ],
        deliveredBy: 'Driver Mwape',
        notes: 'Delivered to reception',
    }, staff);
    check('staff can issue a delivery note', dn.status === 201, `status ${dn.status} ${JSON.stringify(dn.data).slice(0, 140)}`);
    check('delivery notes get their own number series', dn.data?.number === 'DN-0001', dn.data?.number);
    check('a delivery note carries no money', Number(dn.data?.total) === 0 && Number(dn.data?.tax) === 0,
        `total ${dn.data?.total} tax ${dn.data?.tax}`);
    check('lines without a price are accepted', (dn.data?.items || []).length === 2,
        `${(dn.data?.items || []).length} line(s)`);
    check('who delivered it is recorded', dn.data?.deliveredBy === 'Driver Mwape', dn.data?.deliveredBy);

    const dnNoItems = await req('POST', '/sales-documents', {
        docType: 'delivery_note', customerName: 'X', items: [],
    }, staff);
    check('a delivery note still needs at least one line', dnNoItems.status === 400, `status ${dnNoItems.status}`);

    const dnConvert = await req('POST', `/sales-documents/${dn.data?.id}/convert-to-invoice`, {}, staff);
    check('a delivery note cannot be converted to an invoice', dnConvert.status === 400, `status ${dnConvert.status}`);

    // ── 13. Manual receipts ────────────────────────────────────────────────
    const rcp = await req('POST', '/sales-documents', {
        docType: 'receipt',
        customerName: 'Chipata Lodge',
        amount: '1250.50',
        paymentMethod: 'cheque',
        paymentReference: '004321',
        notes: 'Part payment for office furniture',
    }, staff);
    check('staff can issue a receipt', rcp.status === 201, `status ${rcp.status} ${JSON.stringify(rcp.data).slice(0, 140)}`);
    check('receipts get their own number series', rcp.data?.number === 'RCP-0001', rcp.data?.number);
    check('the amount received is stored as the total',
        Number(rcp.data?.total) === 1250.5 && Number(rcp.data?.subtotal) === 1250.5,
        `total ${rcp.data?.total}`);
    check('how it was paid is recorded',
        rcp.data?.paymentMethod === 'cheque' && rcp.data?.paymentReference === '004321',
        `${rcp.data?.paymentMethod} ${rcp.data?.paymentReference}`);
    check('a receipt needs no line items', (rcp.data?.items || []).length === 0);

    const rcpNoAmount = await req('POST', '/sales-documents', {
        docType: 'receipt', customerName: 'X',
    }, staff);
    check('a receipt without an amount is rejected', rcpNoAmount.status === 400, rcpNoAmount.data?.message);
    const rcpZero = await req('POST', '/sales-documents', {
        docType: 'receipt', customerName: 'X', amount: 0,
    }, staff);
    check('a zero receipt is rejected', rcpZero.status === 400, `status ${rcpZero.status}`);
    const rcpNegative = await req('POST', '/sales-documents', {
        docType: 'receipt', customerName: 'X', amount: -50,
    }, staff);
    check('a negative receipt is rejected', rcpNegative.status === 400, `status ${rcpNegative.status}`);
    const rcpNoName = await req('POST', '/sales-documents', {
        docType: 'receipt', amount: 100,
    }, staff);
    check('a receipt must say who paid', rcpNoName.status === 400, `status ${rcpNoName.status}`);

    // The whole point of the design: paperwork doesn't touch the books.
    const ledgerAfterManual = await ledgerAndStock();
    check(
        'receipts and delivery notes post nothing to the ledger and move no stock',
        ledgerAfterManual.journals === ledgerBeforeManual.journals &&
        ledgerAfterManual.stock === ledgerBeforeManual.stock,
        `journals ${ledgerBeforeManual.journals}→${ledgerAfterManual.journals}, stock ${ledgerBeforeManual.stock}→${ledgerAfterManual.stock}`,
    );

    // Editing a receipt keeps the receipt rules.
    const rcpEdit = await req('PUT', `/sales-documents/${rcp.data?.id}`, {
        customerName: 'Chipata Lodge', amount: '1300', paymentMethod: 'cash',
    }, staff);
    check('a draft receipt can be corrected', rcpEdit.status === 200 && Number(rcpEdit.data?.total) === 1300,
        `status ${rcpEdit.status} total ${rcpEdit.data?.total}`);

    const unknownType = await req('POST', '/sales-documents', {
        docType: 'credit_note', customerName: 'X', items: [{ name: 'x', quantity: 1, unitPrice: 1 }],
    }, staff);
    check('an unknown document type is still rejected', unknownType.status === 400, `status ${unknownType.status}`);

    // Numbering is independent per type.
    const dn2 = await req('POST', '/sales-documents', {
        docType: 'delivery_note', customerName: 'Another', items: [{ name: 'Filing Cabinet', quantity: 1 }],
    }, staff);
    check('each type numbers independently', dn2.data?.number === 'DN-0002', dn2.data?.number);
};

run()
    .catch(e => {
        console.error(e);
        check('suite ran to completion', false, e.message);
    })
    .finally(async () => {
        await cleanup().catch(() => {});
        await db.end().catch(() => {});
        const failed = results.filter(r => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length ? 1 : 0);
    });
