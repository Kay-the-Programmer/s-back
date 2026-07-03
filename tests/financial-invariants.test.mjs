/**
 * Financial-invariant test suite.
 *
 * Runs the money pipeline end-to-end against a REAL running backend + Postgres
 * and asserts the accounting guarantees established in the 2026-07 financial
 * audit. Self-contained: it seeds its own throwaway store/user/product directly
 * in the database, so it can run against any empty or existing dev DB (and in
 * CI against a service container) without touching real data.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/financial-invariants.test.mjs
 *
 * Invariants covered:
 *   1.  Discounted sales are accepted and recorded (used to 500 on JE imbalance).
 *   2.  Money fields serialize as numbers, not strings.
 *   3.  A replayed X-Idempotency-Key returns the SAME sale (no duplicate revenue).
 *   4.  Client-tampered totals are recomputed server-side from the cart.
 *   5.  Revenue = subtotal − discount (ex-tax), accrual, per /reports/dashboard.
 *   6.  COGS carries full cost in the sale period.
 *   7.  Returns: over-refund and over-return are rejected.
 *   8.  Refunds reduce revenue in the return period; restocks reverse COGS.
 *   9.  /accounting/summary agrees exactly with /reports/dashboard.
 *   10. Every journal entry for the store is balanced; the discounted sale's
 *       JE credits revenue NET of the discount.
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `fintest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const PRODUCT_ID = `prod-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'fintest-password-1';

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
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`,
        [STORE_ID, `Financial Test Store ${RUN}`]
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Fin Test Owner', $2, $3, 'admin', $4, true)`,
        [USER_ID, EMAIL, hash, STORE_ID]
    );
    await db.query(
        `INSERT INTO products (id, name, description, sku, price, cost_price, stock, status, store_id, image_urls)
         VALUES ($1, 'Invariant Widget', 'financial test product', $2, 100.00, 60.00, 50, 'active', $3, '{}')`,
        [PRODUCT_ID, `FIN-${RUN}`, STORE_ID]
    );
};

const cleanup = async () => {
    // Best-effort: remove the throwaway store's data so repeated local runs
    // don't accumulate. FK order matters; ignore failures (CI DB is disposable).
    const tables = [
        'journal_entry_lines', 'journal_entries', 'return_items', 'returns',
        'payments', 'sale_items', 'sales', 'accounts', 'products', 'audit_logs',
    ];
    for (const t of tables) {
        await db.query(`DELETE FROM ${t} WHERE store_id = $1`, [STORE_ID]).catch(() => { });
    }
    await db.query(`DELETE FROM idempotency_keys WHERE key LIKE $1`, [`${RUN}%`]).catch(() => { });
    await db.query('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => { });
    await db.query('DELETE FROM stores WHERE id = $1', [STORE_ID]).catch(() => { });
};

const main = async () => {
    await db.connect();
    await seed();

    // ---- login ----
    const login = await req('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
    if (!login.data?.token) {
        console.error('FATAL: login failed', login.status, JSON.stringify(login.data).slice(0, 300));
        process.exit(1);
    }
    const H = { Authorization: `Bearer ${login.data.token}` };

    const today = new Date().toISOString().split('T')[0];
    const range = `startDate=${today}&endDate=${today}`;

    const base = await req('GET', `/reports/dashboard?${range}`, null, H);
    const b = base.data.sales;

    // ---- 1+2. discounted sale ----
    const sale1 = await req('POST', '/sales', {
        cart: [{ productId: PRODUCT_ID, name: 'Invariant Widget', price: 100, quantity: 2 }],
        subtotal: 200, discount: 20, tax: 0, total: 180,
        paymentStatus: 'paid', amountPaid: 180, storeCreditUsed: 0,
        payments: [{ amount: 180, method: 'Cash' }],
    }, H);
    check('discounted sale accepted', sale1.status === 201, `status=${sale1.status}`);
    const s1id = sale1.data.transactionId;
    check('money fields are numbers', typeof sale1.data.total === 'number', `typeof total=${typeof sale1.data.total}`);

    // ---- 3. idempotent replay ----
    const body2 = {
        cart: [{ productId: PRODUCT_ID, name: 'Invariant Widget', price: 100, quantity: 1 }],
        subtotal: 100, discount: 0, tax: 0, total: 100,
        paymentStatus: 'paid', amountPaid: 100, storeCreditUsed: 0,
        payments: [{ amount: 100, method: 'Cash' }],
    };
    const key = `${RUN}-idem`;
    const first = await req('POST', '/sales', body2, { ...H, 'X-Idempotency-Key': key });
    const second = await req('POST', '/sales', body2, { ...H, 'X-Idempotency-Key': key });
    check('idempotent replay returns same sale', !!first.data.transactionId && first.data.transactionId === second.data.transactionId,
        `first=${first.data.transactionId} second=${second.data.transactionId}`);

    // ---- 4. tampered totals ----
    const tampered = await req('POST', '/sales', {
        cart: [{ productId: PRODUCT_ID, name: 'Invariant Widget', price: 100, quantity: 1 }],
        subtotal: 999, discount: 0, tax: 0, total: 5,
        paymentStatus: 'paid', amountPaid: 5, storeCreditUsed: 0,
        payments: [{ amount: 100, method: 'Cash' }],
    }, H);
    check('tampered totals recomputed server-side', tampered.status === 201 && +tampered.data.subtotal === 100 && +tampered.data.total === 100,
        `subtotal=${tampered.data.subtotal} total=${tampered.data.total}`);

    // ---- 5+6. reports: accrual, net-of-discount, full-cost COGS ----
    const rep1 = await req('GET', `/reports/dashboard?${range}`, null, H);
    const dRev = +(rep1.data.sales.totalRevenue - b.totalRevenue).toFixed(2);
    const dCogs = +(rep1.data.sales.totalCogs - b.totalCogs).toFixed(2);
    check('revenue = subtotal − discount, dupe excluded (+380)', dRev === 380, `delta=${dRev}`);
    check('COGS full cost in sale period (+240)', dCogs === 240, `delta=${dCogs}`);

    // ---- 7+8. returns: guards + period matching ----
    const ret = await req('POST', '/returns', {
        originalSaleId: s1id,
        returnedItems: [{ productId: PRODUCT_ID, productName: 'Invariant Widget', quantity: 1, reason: 'test', addToStock: true }],
        refundAmount: 90, refundMethod: 'cash',
    }, H);
    check('valid return accepted', ret.status === 201, `status=${ret.status}`);

    const overRefund = await req('POST', '/returns', {
        originalSaleId: s1id,
        returnedItems: [{ productId: PRODUCT_ID, productName: 'Invariant Widget', quantity: 1, reason: 'test', addToStock: true }],
        refundAmount: 500, refundMethod: 'cash',
    }, H);
    check('over-refund rejected', overRefund.status === 400, `status=${overRefund.status}`);

    const overReturn = await req('POST', '/returns', {
        originalSaleId: s1id,
        returnedItems: [{ productId: PRODUCT_ID, productName: 'Invariant Widget', quantity: 5, reason: 'test', addToStock: true }],
        refundAmount: 10, refundMethod: 'cash',
    }, H);
    check('over-return rejected', overReturn.status === 400, `status=${overReturn.status}`);

    const rep2 = await req('GET', `/reports/dashboard?${range}`, null, H);
    const dRev2 = +(rep2.data.sales.totalRevenue - b.totalRevenue).toFixed(2);
    const dCogs2 = +(rep2.data.sales.totalCogs - b.totalCogs).toFixed(2);
    check('refund reduces revenue in return period (+290)', dRev2 === 290, `delta=${dRev2}`);
    check('restock reverses COGS in return period (+180)', dCogs2 === 180, `delta=${dCogs2}`);

    // ---- 9. one source of truth ----
    const sum = await req('GET', `/accounting/summary?${range}`, null, H);
    check('summary revenue == reports revenue', Math.abs(sum.data.period.revenue - rep2.data.sales.totalRevenue) < 0.01,
        `summary=${sum.data.period.revenue} reports=${rep2.data.sales.totalRevenue}`);
    check('summary cogs == reports cogs', Math.abs(sum.data.period.cogs - rep2.data.sales.totalCogs) < 0.01,
        `summary=${sum.data.period.cogs} reports=${rep2.data.sales.totalCogs}`);

    // ---- 10. general ledger invariants (direct SQL) ----
    const unbalanced = await db.query(
        `SELECT COUNT(*)::int AS n FROM (
            SELECT journal_entry_id FROM journal_entry_lines WHERE store_id = $1
            GROUP BY journal_entry_id
            HAVING ABS(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END)) > 0.01
         ) x`, [STORE_ID]);
    check('every journal entry balanced', unbalanced.rows[0].n === 0, `unbalanced=${unbalanced.rows[0].n}`);

    const revLine = await db.query(
        `SELECT COALESCE(SUM(jel.amount), 0) AS rev
         FROM journal_entry_lines jel
         JOIN journal_entries je ON jel.journal_entry_id = je.id
         JOIN accounts a ON jel.account_id = a.id
         WHERE je.source_id = $1 AND jel.store_id = $2 AND jel.type = 'credit' AND a.type = 'revenue'`,
        [s1id, STORE_ID]);
    check('discounted sale JE books revenue net of discount (180)', Math.abs(Number(revLine.rows[0].rev) - 180) < 0.01,
        `booked=${revLine.rows[0].rev}`);

    const stock = await db.query('SELECT stock FROM products WHERE id = $1', [PRODUCT_ID]);
    check('stock reconciles (50 − 4 sold + 1 restocked = 47)', Math.abs(Number(stock.rows[0].stock) - 47) < 0.001,
        `stock=${stock.rows[0].stock}`);

    const fails = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - fails}/${results.length} invariants hold`);

    await cleanup();
    await db.end();
    process.exit(fails ? 1 : 0);
};

main().catch(async (e) => {
    console.error('SUITE ERROR:', e);
    await cleanup().catch(() => { });
    await db.end().catch(() => { });
    process.exit(1);
});
