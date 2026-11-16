/**
 * The 2026-11-16 "simpler and more accurate" changes, end to end through the API.
 *
 *  - Expenses: everyday categories exist as accounts; system accounts (Cost of
 *    Goods Sold, Inventory Adjustment) are neither offered nor accepted.
 *  - Customer payments: one payment settles the oldest invoices first, and
 *    cannot exceed what is owed.
 *  - Refunds: the server works out the amount from the sale; a figure sent by
 *    the till is ignored (zero-rated goods get no tax added).
 *
 * Self-contained: seeds a throwaway store and user, and removes them after.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/simpler-flows.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `simpler-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const CUST_ID = `cust-${RUN}`;
const BREAD = `prod-bread-${RUN}`;
const MAIZE = `prod-maize-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'simpler-password-1';

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

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`, [STORE_ID, `Simpler Flows ${RUN}`]);
    await db.query(`INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified) VALUES ($1, 'Flows Owner', $2, $3, 'admin', $4, true)`, [USER_ID, EMAIL, hash, STORE_ID]);
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled, enabled_modules)
         VALUES ($1, 'Simpler Flows', 16, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, false, '{}')`, [STORE_ID]);
    await db.query(`INSERT INTO customers (id, name, phone, store_id, account_balance) VALUES ($1, 'Mrs Banda', '0977000111', $2, 180)`, [CUST_ID, STORE_ID]);
    for (const [id, name, cls] of [[BREAD, 'Bread', 'standard'], [MAIZE, 'Maize meal', 'zero']]) {
        await db.query(
            `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, tax_class)
             VALUES ($1, $2, $1, 100, 60, 10, 'active', $3, '{}', $4)`, [id, name, STORE_ID, cls]);
    }
    // Two unpaid credit sales (invoices) for Mrs Banda: 100 (older) and 80.
    const inv = async (id, total, daysAgo) => {
        const ts = new Date(Date.now() - daysAgo * 86400000).toISOString();
        await db.query(
            `INSERT INTO sales (transaction_id, "timestamp", customer_id, total, subtotal, tax, discount, payment_status, amount_paid, due_date, refund_status, store_id)
             VALUES ($1, $2, $3, $4, $4, 0, 0, 'unpaid', 0, $5, 'none', $6)`,
            [id, ts, CUST_ID, total, new Date(Date.parse(ts) + 30 * 86400000).toISOString(), STORE_ID]);
    };
    await inv(`INV-A-${RUN}`, 100, 20);
    await inv(`INV-B-${RUN}`, 80, 5);
    // A paid cash sale: Bread 100 (+16 tax) and Maize meal 50 (zero-rated) = 166.
    await db.query(
        `INSERT INTO sales (transaction_id, "timestamp", total, subtotal, tax, discount, payment_status, amount_paid, refund_status, store_id, tax_breakdown)
         VALUES ($1, NOW(), 166, 150, 16, 0, 'paid', 166, 'none', $2, $3)`,
        [`SALE-${RUN}`, STORE_ID, JSON.stringify([{ net: 100, tax: 16, ratePct: 16, taxClass: 'standard' }, { net: 50, tax: 0, ratePct: 0, taxClass: 'zero' }])]);
    await db.query(`INSERT INTO sale_items (sale_id, product_id, quantity, price_at_sale, cost_at_sale, returned_quantity, store_id, tax_class) VALUES ($1, $2, 1, 100, 60, 0, $3, 'standard')`, [`SALE-${RUN}`, BREAD, STORE_ID]);
    await db.query(`INSERT INTO sale_items (sale_id, product_id, quantity, price_at_sale, cost_at_sale, returned_quantity, store_id, tax_class) VALUES ($1, $2, 1, 50, 30, 0, $3, 'zero')`, [`SALE-${RUN}`, MAIZE, STORE_ID]);
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

        // ── Expenses ──
        const opts = await req('GET', '/expenses/accounts', null, H);
        const names = (opts.data?.expenseAccounts || []).map(a => `${a.number} ${a.name}`);
        check('expense categories exist as accounts (Utilities 6030, Salaries 6040)',
            names.includes('6030 Utilities') && names.includes('6040 Salaries & Wages'), names.join(', '));
        check('Cost of Goods Sold is not offered for expenses', !names.some(n => /Cost of Goods Sold/.test(n)));
        const all = (await req('GET', '/accounting/accounts', null, H)).data;
        const cogs = all.find(a => a.subType === 'cogs');
        const util = all.find(a => a.number === '6030');
        const cash = all.find(a => a.subType === 'cash');
        const toCogs = await req('POST', '/expenses', { date: new Date().toISOString().slice(0, 10), description: 'Electricity', amount: 50, expenseAccountId: cogs.id, paymentAccountId: cash.id }, H);
        check('an expense charged to Cost of Goods Sold is refused (400)', toCogs.status === 400, toCogs.data?.message);
        const toUtil = await req('POST', '/expenses', { date: new Date().toISOString().slice(0, 10), description: 'Electricity', amount: 50, expenseAccountId: util.id, paymentAccountId: cash.id, category: 'Utilities' }, H);
        check('the same expense charged to Utilities is accepted', toUtil.status === 201 || toUtil.status === 200, `status=${toUtil.status}`);

        // ── Customer payment across invoices ──
        const over = await req('POST', `/customers/${CUST_ID}/payments`, { amount: 200, method: 'Cash' }, H);
        check('paying more than is owed (180) is refused', over.status === 400 && /more than/i.test(over.data?.message || ''), over.data?.message);
        const pay = await req('POST', `/customers/${CUST_ID}/payments`, { amount: 150, method: 'Cash' }, H);
        check('one payment of 150 is accepted', pay.status === 200, `status=${pay.status}`);
        const a = (await db.query('SELECT amount_paid, payment_status FROM sales WHERE transaction_id = $1', [`INV-A-${RUN}`])).rows[0];
        const b = (await db.query('SELECT amount_paid, payment_status FROM sales WHERE transaction_id = $1', [`INV-B-${RUN}`])).rows[0];
        check('the older invoice (100) is paid in full first', near(a.amount_paid, 100) && a.payment_status === 'paid', `${a.amount_paid} ${a.payment_status}`);
        check('the remaining 50 goes to the newer invoice (50 of 80)', near(b.amount_paid, 50) && b.payment_status === 'partially_paid', `${b.amount_paid} ${b.payment_status}`);
        check('the reply says 30 is still owed', near(pay.data?.remainingOwed, 30), `remaining=${pay.data?.remainingOwed}`);
        const bal = (await db.query('SELECT account_balance FROM customers WHERE id = $1', [CUST_ID])).rows[0];
        check('the customer balance drops by 150 (180 → 30)', near(bal.account_balance, 30), `balance=${bal.account_balance}`);
        const payments = (await db.query('SELECT count(*) FROM payments WHERE store_id = $1', [STORE_ID])).rows[0].count;
        check('two payment rows, one per invoice touched', Number(payments) === 2, `rows=${payments}`);

        // ── Refunds worked out by the server ──
        const ret = await req('POST', '/returns', {
            originalSaleId: `SALE-${RUN}`,
            returnedItems: [{ productId: MAIZE, productName: 'Maize meal', quantity: 1, reason: 'Other', addToStock: true }],
            refundAmount: 58, // what the old till sent: 50 + 16% on a zero-rated item
            refundMethod: 'original_method',
        }, H);
        check('returning the zero-rated item refunds 50.00, not the 58.00 sent', ret.status === 201 && near(ret.data?.refundAmount, 50), `status=${ret.status} refund=${ret.data?.refundAmount}`);
        const ret2 = await req('POST', '/returns', {
            originalSaleId: `SALE-${RUN}`,
            returnedItems: [{ productId: BREAD, productName: 'Bread', quantity: 1, reason: 'Other', addToStock: true }],
            refundAmount: 1,
            refundMethod: 'original_method',
        }, H);
        check('returning the bread refunds 116.00 whatever the till sent', ret2.status === 201 && near(ret2.data?.refundAmount, 116), `refund=${ret2.data?.refundAmount}`);
        const sale = (await db.query('SELECT refund_status FROM sales WHERE transaction_id = $1', [`SALE-${RUN}`])).rows[0];
        check('the sale is fully returned (50 + 116 = 166)', sale.refund_status === 'returned', sale.refund_status);
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
