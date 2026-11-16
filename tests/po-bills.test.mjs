/**
 * A supplier bill follows the goods actually received — never the order.
 *
 * Before: placing an order raised a bill for the full amount at once, so
 * payables counted goods still on the road, and cancelling left the bill.
 * Now (accountingService.syncSupplierBillForPO) the bill is the value
 * received, plus that share of the order's tax and delivery, and every change
 * posts a balanced journal. GR/IR nets to zero once an order is complete.
 *
 * Self-contained: seeds a throwaway store and user, and removes them after.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/po-bills.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `pobill-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const SUPPLIER_ID = `sup-${RUN}`;
const PROD_ID = `prod-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'pobill-password-1';

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.006;

const req = async (method, path, body, headers = {}) => {
    const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
};

const db = new pg.Client({ connectionString: DATABASE_URL });
const billOf = async (poId) => (await db.query('SELECT amount, amount_paid, status FROM supplier_invoices WHERE purchase_order_id = $1', [poId])).rows[0];
/** Every journal line in this store must balance overall. */
const ledgerBalanced = async () => {
    const r = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END), 0) AS net FROM journal_entry_lines WHERE store_id = $1`, [STORE_ID]);
    return near(r.rows[0].net, 0);
};
/** Net balance on an account by sub-type (debit positive). */
const accountNet = async (subType) => {
    const r = await db.query(
        `SELECT COALESCE(SUM(CASE WHEN l.type='debit' THEN l.amount ELSE -l.amount END), 0) AS net
           FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id
          WHERE l.store_id = $1 AND a.sub_type = $2`, [STORE_ID, subType]);
    return Number(r.rows[0].net);
};

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`, [STORE_ID, `PO Bill Test ${RUN}`]);
    await db.query(`INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified) VALUES ($1, 'Bill Test Owner', $2, $3, 'admin', $4, true)`, [USER_ID, EMAIL, hash, STORE_ID]);
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled, enabled_modules)
         VALUES ($1, 'PO Bill Test', 16, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, false, '{}')`, [STORE_ID]);
    await db.query(`INSERT INTO suppliers (id, name, store_id) VALUES ($1, 'Ndola Distributors', $2)`, [SUPPLIER_ID, STORE_ID]);
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, supplier_id)
         VALUES ($1, 'Cooking Oil', $2, 9, 5, 0, 'active', $3, '{}', $4)`, [PROD_ID, `P-${RUN}`, STORE_ID, SUPPLIER_ID]);
};

const cleanup = async () => {
    const { rows } = await db.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'store_id' AND table_schema = 'public'`);
    for (let pass = 0; pass < 4; pass++) {
        for (const { table_name } of rows) {
            if (table_name === 'stores') continue;
            await db.query(`DELETE FROM "${table_name}" WHERE store_id = $1`, [STORE_ID]).catch(() => {});
        }
    }
    await db.query('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = $1', [STORE_ID]).catch(() => {});
};

const main = async () => {
    await db.connect();
    await seed();
    try {
        const login = await req('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
        if (!login.data?.token) throw new Error(`login failed: ${login.status}`);
        const H = { Authorization: `Bearer ${login.data.token}` };

        // 10 @ 5 = 50, plus 8 tax = 58.
        const order = (status = 'ordered', received = 0) => req('POST', '/purchase-orders', {
            id: `new_${Date.now()}`, poNumber: 'x', supplierId: SUPPLIER_ID, supplierName: 'Ndola Distributors', status,
            items: [{ productId: PROD_ID, productName: 'Cooking Oil', sku: 'P', quantity: 10, costPrice: 5, receivedQuantity: received }],
            createdAt: new Date().toISOString(), orderedAt: new Date().toISOString(), subtotal: 50, shippingCost: 0, tax: 8, total: 58,
        }, H);
        const receive = (poId, quantity) => req('POST', `/purchase-orders/${poId}/receive`, [{ productId: PROD_ID, quantity }], H);

        // ── Placing an order owes nothing yet ──
        const a = (await order()).data;
        check('placing an order raises no bill', !(await billOf(a.id)));

        // ── Part delivery: bill = goods received + their share of tax ──
        await receive(a.id, 4);
        let bill = await billOf(a.id);
        check('4 of 10 received: bill is 4×5 + 8×(20/50) = 23.20', bill && near(bill.amount, 23.2), `bill=${bill?.amount}`);
        check('the ledger balances after a part delivery', await ledgerBalanced());

        // ── The rest arrives: the full order, tax and all ──
        await receive(a.id, 6);
        bill = await billOf(a.id);
        check('fully received: bill is the order total 58.00', bill && near(bill.amount, 58), `bill=${bill?.amount}`);
        check('GR/IR nets to zero once the order is complete', near(await accountNet('gr_ir'), 0), `net=${await accountNet('gr_ir')}`);
        check('payables show exactly 58 owed', near(-(await accountNet('accounts_payable')), 58), `ap=${-(await accountNet('accounts_payable'))}`);

        // ── Cancelled after a part delivery: only the delivered part is owed ──
        const b = (await order()).data;
        await receive(b.id, 3);
        const placed = (await req('GET', '/purchase-orders', null, H)).data;
        const bFull = (Array.isArray(placed) ? placed : placed.data || []).find(p => p.id === b.id);
        await req('PUT', `/purchase-orders/${b.id}`, { ...bFull, status: 'canceled' }, H);
        bill = await billOf(b.id);
        check('cancelled after 3 of 10: bill stays at the delivered 17.40', bill && near(bill.amount, 17.4), `bill=${bill?.amount}`);

        // ── Cancelled before anything arrives: nothing owed ──
        const c = (await order()).data;
        const placedC = (await req('GET', '/purchase-orders', null, H)).data;
        const cFull = (Array.isArray(placedC) ? placedC : placedC.data || []).find(p => p.id === c.id);
        await req('PUT', `/purchase-orders/${c.id}`, { ...cFull, status: 'canceled' }, H);
        check('cancelled before delivery: no bill', !(await billOf(c.id)));

        // ── Recorded as already received (Inventory "record as purchase") ──
        const d = (await order('received', 10)).data;
        bill = await billOf(d.id);
        check('an order recorded as received is billed straight away (58.00)', bill && near(bill.amount, 58), `bill=${bill?.amount}`);

        check('the whole ledger still balances', await ledgerBalanced());
    } finally {
        await cleanup();
        await db.end();
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) { console.log('Failed:'); failed.forEach(f => console.log(`  - ${f.name}`)); process.exit(1); }
};

main().catch(async (err) => {
    console.error('FATAL', err);
    try { await cleanup(); await db.end(); } catch { /* ignore */ }
    process.exit(1);
});
