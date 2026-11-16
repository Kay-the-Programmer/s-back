/**
 * The 2026-11-16 process simplifications, end to end through the API.
 *
 *  - Online orders: accept, then cancel puts the stock back and reverses the books.
 *  - Till PIN: each person sets their own; PINs are unique per shop; typing
 *    someone's PIN hands the till to them; guessing is limited.
 *  - Pay supplier: one payment settles the oldest bills first, never more than owed.
 *
 * Self-contained: seeds a throwaway store and users, and removes them after.
 *   node tests/process-flows.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `flows-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const OWNER = `user-a-${RUN}`;
const CASHIER = `user-b-${RUN}`;
const SUPPLIER_ID = `sup-${RUN}`;
const PROD = `prod-${RUN}`;
const PASSWORD = 'flows-password-1';

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
    await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`, [STORE_ID, `Flows ${RUN}`]);
    await db.query(`INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified) VALUES ($1, 'Owner Ann', $2, $3, 'admin', $4, true)`, [OWNER, `a-${RUN}@test.local`, hash, STORE_ID]);
    await db.query(`INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified) VALUES ($1, 'Cashier Ben', $2, $3, 'staff', $4, true)`, [CASHIER, `b-${RUN}@test.local`, hash, STORE_ID]);
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled, enabled_modules)
         VALUES ($1, 'Flows', 0, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true, '{}')`, [STORE_ID]);
    await db.query(`INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls) VALUES ($1, 'Soap', $1, 20, 12, 10, 'active', $2, '{}')`, [PROD, STORE_ID]);
    await db.query(`INSERT INTO suppliers (id, name, store_id) VALUES ($1, 'Kafue Wholesale', $2)`, [SUPPLIER_ID, STORE_ID]);
};

const cleanup = async () => {
    const { rows } = await db.query(`SELECT table_name FROM information_schema.columns WHERE column_name = 'store_id' AND table_schema = 'public'`);
    for (let pass = 0; pass < 4; pass++) {
        for (const { table_name } of rows) {
            if (table_name === 'stores') continue;
            await db.query(`DELETE FROM "${table_name}" WHERE store_id = $1`, [STORE_ID]).catch(() => {});
        }
    }
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[OWNER, CASHIER]]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = $1', [STORE_ID]).catch(() => {});
};

const main = async () => {
    await db.connect();
    await seed();
    try {
        const login = async (who) => {
            const r = await req('POST', '/auth/login', { email: `${who}-${RUN}@test.local`, password: PASSWORD });
            if (!r.data?.token) throw new Error(`login failed: ${r.status}`);
            return { Authorization: `Bearer ${r.data.token}` };
        };
        const A = await login('a');
        const B = await login('b');
        const stock = async () => Number((await db.query('SELECT stock FROM products WHERE id = $1', [PROD])).rows[0].stock);

        // ── Online order: accept, then cancel ──
        const sale = await req('POST', '/sales', {
            cart: [{ productId: PROD, name: 'Soap', price: 20, quantity: 3 }],
            subtotal: 60, discount: 0, tax: 0, total: 60, paymentStatus: 'unpaid', amountPaid: 0, storeCreditUsed: 0, payments: [],
        }, A);
        const id = sale.data?.transactionId;
        await db.query(`UPDATE sales SET fulfillment_status = 'pending', channel = 'online' WHERE transaction_id = $1`, [id]);
        check('order placed takes 3 off stock (10 → 7)', (await stock()) === 7, `stock=${await stock()}`);
        const acc = await req('PUT', `/sales/${id}/fulfillment`, { status: 'accepted' }, A);
        check('order can be accepted', acc.status === 200, `status=${acc.status}`);
        const can = await req('PUT', `/sales/${id}/fulfillment`, { status: 'cancelled' }, A);
        check('accepted order can be cancelled', can.status === 200, `status=${can.status}`);
        check('cancelling puts the stock back (→ 10)', (await stock()) === 10, `stock=${await stock()}`);
        const rev = (await db.query(
            `SELECT COALESCE(SUM(CASE WHEN l.type='credit' THEN l.amount ELSE -l.amount END),0) AS net
               FROM journal_entry_lines l JOIN accounts a ON a.id = l.account_id AND a.store_id = l.store_id
              WHERE l.store_id = $1 AND a.sub_type = 'sales_revenue'`, [STORE_ID])).rows[0].net;
        check('the sale is reversed in the books (revenue back to 0)', near(rev, 0), `revenue=${rev}`);

        // ── Till PIN ──
        const setA = await req('PUT', '/auth/till-pin', { pin: '2468' }, A);
        check('owner sets a till PIN', setA.status === 200 && setA.data?.hasTillPin === true, `status=${setA.status}`);
        const dupB = await req('PUT', '/auth/till-pin', { pin: '2468' }, B);
        check('the same PIN cannot be taken by someone else in the shop', dupB.status === 409, `status=${dupB.status}`);
        const bad = await req('PUT', '/auth/till-pin', { pin: '12' }, B);
        check('a 2-digit PIN is refused', bad.status === 400, `status=${bad.status}`);
        await req('PUT', '/auth/till-pin', { pin: '1357' }, B);
        const sw = await req('POST', '/auth/till-switch', { pin: '1357' }, A);
        check('typing Ben\'s PIN on Ann\'s till hands it to Ben', sw.status === 200 && sw.data?.id === CASHIER && !!sw.data?.token, `status=${sw.status} id=${sw.data?.id}`);
        const me = await req('GET', '/auth/me', null, { Authorization: `Bearer ${sw.data?.token}` });
        check('the new session is Ben\'s', me.data?.id === CASHIER || me.data?.user?.id === CASHIER, JSON.stringify(me.data).slice(0, 80));
        let last;
        for (let i = 0; i < 6; i++) last = await req('POST', '/auth/till-switch', { pin: '0000' }, B);
        check('after 5 wrong PINs the till must wait (429)', last.status === 429, `status=${last.status}`);

        // ── Pay a supplier across bills ──
        const bill = (id, amount, dueDays) => db.query(
            `INSERT INTO supplier_invoices (id, invoice_number, supplier_id, supplier_name, invoice_date, due_date, amount, amount_paid, status, store_id)
             VALUES ($1, $1, $2, 'Kafue Wholesale', NOW(), NOW() + ($3 || ' days')::interval, $4, 0, 'unpaid', $5)`,
            [id, SUPPLIER_ID, String(dueDays), amount, STORE_ID]);
        await bill(`BILL-OLD-${RUN}`, 100, 5);
        await bill(`BILL-NEW-${RUN}`, 80, 20);
        const over = await req('POST', `/accounting/suppliers/${SUPPLIER_ID}/payments`, { amount: 200, method: 'Cash' }, A);
        check('paying more than is owed (180) is refused', over.status === 400, over.data?.message);
        const pay = await req('POST', `/accounting/suppliers/${SUPPLIER_ID}/payments`, { amount: 150, method: 'Mobile Money' }, A);
        check('one payment of 150 is accepted', pay.status === 200, `status=${pay.status} ${pay.data?.message || ''}`);
        const st = async (id) => (await db.query('SELECT amount_paid, status FROM supplier_invoices WHERE id = $1', [id])).rows[0];
        const o = await st(`BILL-OLD-${RUN}`), n = await st(`BILL-NEW-${RUN}`);
        check('the bill due first (100) is paid in full', near(o.amount_paid, 100) && o.status === 'paid', `${o.amount_paid} ${o.status}`);
        check('the rest (50) goes to the next bill', near(n.amount_paid, 50) && n.status === 'partially_paid', `${n.amount_paid} ${n.status}`);
        check('reply says 30 still owed', near(pay.data?.remainingOwed, 30), `remaining=${pay.data?.remainingOwed}`);
        const momo = (await db.query(`SELECT balance FROM accounts WHERE store_id = $1 AND sub_type = 'mobile_money'`, [STORE_ID])).rows[0];
        check('the money comes out of Mobile Money (−150)', momo && near(momo.balance, -150), `momo=${momo?.balance}`);
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
