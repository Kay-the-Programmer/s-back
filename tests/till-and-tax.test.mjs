/**
 * Till sessions and per-product tax, end to end.
 *
 * Runs against a REAL backend + Postgres. The arithmetic in both features is
 * unit-tested elsewhere (tests/cash-math, tests/tax); what this covers is
 * everything those cannot: that the columns exist, that the SQL is valid, that
 * a sale is stamped with the till it passed through, and that the server —
 * not the client — decides what tax is charged.
 *
 * Self-contained: seeds a throwaway store, user and products, and removes them
 * afterwards, so it can run against any dev database.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/till-and-tax.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `tilltest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const STD_ID = `prod-std-${RUN}`;
const ZERO_ID = `prod-zero-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'tilltest-password-1';

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
const near = (a, b, tol = 0.011) => Math.abs(Number(a) - Number(b)) <= tol;

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`,
        [STORE_ID, `Till Test Store ${RUN}`],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Till Test Owner', $2, $3, 'admin', $4, true)`,
        [USER_ID, EMAIL, hash, STORE_ID],
    );
    // 16% standard rate, prices quoted excluding tax — the default a store has.
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled)
         VALUES ($1, 'Till Test Store', 16, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true)`,
        [STORE_ID],
    );
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, tax_class)
         VALUES ($1, 'Bar Soap', $2, 100.00, 60.00, 500, 'active', $3, '{}', 'standard')`,
        [STD_ID, `STD-${RUN}`, STORE_ID],
    );
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, tax_class)
         VALUES ($1, 'Mealie Meal 25kg', $2, 200.00, 150.00, 500, 'active', $3, '{}', 'zero')`,
        [ZERO_ID, `ZERO-${RUN}`, STORE_ID],
    );
};

const cleanup = async () => {
    const tables = [
        'journal_entry_lines', 'journal_entries', 'return_items', 'returns',
        'payments', 'sale_items', 'sales', 'cash_movements', 'cash_sessions',
        'sales_document_items', 'sales_documents', 'accounts', 'products', 'audit_logs',
        'store_settings',
    ];
    for (const t of tables) {
        await db.query(`DELETE FROM ${t} WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    }
    await db.query('DELETE FROM users WHERE id = $1', [USER_ID]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = $1', [STORE_ID]).catch(() => {});
};

const main = async () => {
    await db.connect();
    await seed();

    const login = await req('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
    if (!login.data?.token) {
        console.error('FATAL: login failed', login.status, JSON.stringify(login.data).slice(0, 300));
        process.exit(1);
    }
    const H = { Authorization: `Bearer ${login.data.token}` };

    // ---------------------------------------------------------------- tax ---

    // A mixed basket, priced the way a client that had NOT been updated would
    // price it: 16% on the whole lot. The server must overrule it, because the
    // mealie meal is zero-rated.
    const mixed = await req('POST', '/sales', {
        cart: [
            { productId: ZERO_ID, name: 'Mealie Meal 25kg', price: 200, quantity: 1 },
            { productId: STD_ID, name: 'Bar Soap', price: 100, quantity: 1 },
        ],
        subtotal: 300, discount: 0, tax: 48, total: 348,
        paymentStatus: 'paid', amountPaid: 348, storeCreditUsed: 0,
        payments: [{ amount: 348, method: 'Cash' }],
    }, H);
    check('mixed basket sale accepted', mixed.status === 201, `status=${mixed.status}`);
    check('server charges tax only on the standard-rated line',
        near(mixed.data?.tax, 16), `tax=${mixed.data?.tax} (client claimed 48)`);
    check('server recomputes the total to match',
        near(mixed.data?.total, 316), `total=${mixed.data?.total}`);

    const mixedId = mixed.data?.transactionId;

    // The breakdown a receipt prints, frozen on the sale.
    const bd = await db.query('SELECT tax_breakdown FROM sales WHERE transaction_id = $1', [mixedId]);
    const parts = bd.rows[0]?.tax_breakdown ?? null;
    check('tax breakdown is stored on the sale', Array.isArray(parts) && parts.length === 2,
        `breakdown=${JSON.stringify(parts)}`);
    if (Array.isArray(parts)) {
        const summed = parts.reduce((a, p) => a + Number(p.tax), 0);
        check('breakdown sums to the tax charged', near(summed, mixed.data?.tax),
            `sum=${summed} tax=${mixed.data?.tax}`);
        const zero = parts.find(p => p.taxClass === 'zero');
        check('zero-rated goods appear, taxed at nothing',
            !!zero && near(zero.tax, 0) && near(zero.net, 200), JSON.stringify(zero));
    }

    // Line-level classes, for tax reporting that goes deeper than the total.
    const lines = await db.query(
        'SELECT product_id, tax_class FROM sale_items WHERE sale_id = $1 ORDER BY product_id', [mixedId]);
    check('each sale line records the class it was sold under',
        lines.rows.length === 2 && lines.rows.every(r => ['standard', 'zero'].includes(r.tax_class)),
        JSON.stringify(lines.rows));

    // A client that DOES price correctly is trusted, and still gets a breakdown.
    const correct = await req('POST', '/sales', {
        cart: [
            { productId: ZERO_ID, name: 'Mealie Meal 25kg', price: 200, quantity: 1 },
            { productId: STD_ID, name: 'Bar Soap', price: 100, quantity: 1 },
        ],
        subtotal: 300, discount: 0, tax: 16, total: 316,
        paymentStatus: 'paid', amountPaid: 316, storeCreditUsed: 0,
        payments: [{ amount: 316, method: 'Cash' }],
    }, H);
    const correctBd = await db.query(
        'SELECT tax_breakdown FROM sales WHERE transaction_id = $1', [correct.data?.transactionId]);
    check('a correctly-priced sale still carries a breakdown',
        Array.isArray(correctBd.rows[0]?.tax_breakdown), JSON.stringify(correctBd.rows[0]?.tax_breakdown));

    // Tax-inclusive pricing: the marked price is what the customer pays.
    await db.query('UPDATE store_settings SET prices_include_tax = TRUE WHERE store_id = $1', [STORE_ID]);
    const inclusive = await req('POST', '/sales', {
        cart: [{ productId: STD_ID, name: 'Bar Soap', price: 116, quantity: 1 }],
        // Deliberately wrong, to force the server to price it.
        subtotal: 116, discount: 0, tax: 99, total: 999,
        paymentStatus: 'paid', amountPaid: 999, storeCreditUsed: 0,
        payments: [{ amount: 999, method: 'Cash' }],
    }, H);
    check('inclusive pricing leaves the marked price standing',
        near(inclusive.data?.total, 116), `total=${inclusive.data?.total}`);
    check('inclusive pricing extracts the tax from the price',
        near(inclusive.data?.tax, 16) && near(inclusive.data?.subtotal, 100),
        `tax=${inclusive.data?.tax} subtotal=${inclusive.data?.subtotal}`);
    await db.query('UPDATE store_settings SET prices_include_tax = FALSE WHERE store_id = $1', [STORE_ID]);

    // --------------------------------------------------------------- till ---

    const open = await req('POST', '/cash-sessions', { openingFloat: 500 }, H);
    check('till opens with a counted float', open.status === 201 && near(open.data?.openingFloat, 500),
        `status=${open.status} float=${open.data?.openingFloat}`);
    const sessionId = open.data?.id;

    // The partial unique index, not a check-then-insert, is what makes this safe.
    const second = await req('POST', '/cash-sessions', { openingFloat: 100 }, H);
    check('a second till cannot be opened by the same person', second.status === 409,
        `status=${second.status}`);

    // A cashier must not be shown what the drawer should hold before counting it.
    const current = await req('GET', '/cash-sessions/current', null, H);
    check('the open till never reveals the expected cash',
        current.data?.expectedCash === null, `expectedCash=${current.data?.expectedCash}`);

    // Sales made now belong to this till — stamped server-side, so an offline
    // or desktop client lands in the right session without knowing tills exist.
    const cashSale = await req('POST', '/sales', {
        cart: [{ productId: STD_ID, name: 'Bar Soap', price: 100, quantity: 1 }],
        subtotal: 100, discount: 0, tax: 16, total: 116,
        paymentStatus: 'paid', amountPaid: 116, storeCreditUsed: 0,
        payments: [{ amount: 116, method: 'Cash' }],
    }, H);
    const stamped = await db.query(
        'SELECT cash_session_id FROM sales WHERE transaction_id = $1', [cashSale.data?.transactionId]);
    check('a sale is stamped with the till it passed through',
        stamped.rows[0]?.cash_session_id === sessionId,
        `stamped=${stamped.rows[0]?.cash_session_id} session=${sessionId}`);

    // Takings that never touch the drawer must not be expected in it.
    await req('POST', '/sales', {
        cart: [{ productId: STD_ID, name: 'Bar Soap', price: 100, quantity: 2 }],
        subtotal: 200, discount: 0, tax: 32, total: 232,
        paymentStatus: 'paid', amountPaid: 232, storeCreditUsed: 0,
        payments: [{ amount: 232, method: 'Mobile Money' }],
    }, H);

    const payOut = await req('POST', `/cash-sessions/${sessionId}/movements`,
        { type: 'pay_out', amount: 50, reason: 'Delivery driver' }, H);
    check('a pay-out is recorded', payOut.status === 201, `status=${payOut.status}`);
    const payIn = await req('POST', `/cash-sessions/${sessionId}/movements`,
        { type: 'pay_in', amount: 30, reason: 'Float top-up' }, H);
    check('a pay-in is recorded', payIn.status === 201, `status=${payIn.status}`);

    const noReason = await req('POST', `/cash-sessions/${sessionId}/movements`,
        { type: 'pay_out', amount: 10 }, H);
    check('an unexplained movement is refused', noReason.status === 400, `status=${noReason.status}`);

    // Expected = 500 float + 116 cash sale − 0 refunds + 30 in − 50 out = 596.
    // The mobile-money 232 is takings but never entered the drawer.
    const shortBy = 20;
    const close = await req('POST', `/cash-sessions/${sessionId}/close`,
        { countedCash: 596 - shortBy, notes: 'e2e' }, H);
    check('till closes on a counted drawer', close.status === 200, `status=${close.status}`);
    check('expected cash counts only what crossed the drawer',
        near(close.data?.expectedCash, 596), `expected=${close.data?.expectedCash}`);
    check('variance reports the shortage', near(close.data?.variance, -shortBy),
        `variance=${close.data?.variance}`);
    check('the count is kept alongside it', near(close.data?.countedCash, 576),
        `counted=${close.data?.countedCash}`);

    const closeAgain = await req('POST', `/cash-sessions/${sessionId}/close`, { countedCash: 1 }, H);
    check('a closed till cannot be closed twice',
        closeAgain.status === 409 || closeAgain.status === 404, `status=${closeAgain.status}`);

    const after = await req('GET', '/cash-sessions/current', null, H);
    check('closing the till leaves none open', after.data === null || after.data === '',
        `current=${JSON.stringify(after.data)}`);

    // ------------------------------------------------------ sales document ---

    const invoice = await req('POST', '/sales-documents', {
        docType: 'invoice',
        customerName: 'Till Test Customer',
        items: [
            { productId: ZERO_ID, name: 'Mealie Meal 25kg', quantity: 1, unitPrice: 200 },
            { productId: STD_ID, name: 'Bar Soap', quantity: 1, unitPrice: 100 },
        ],
        discount: 0,
    }, H);
    check('invoice with a mixed basket is accepted', invoice.status === 201, `status=${invoice.status}`);
    check('invoice taxes only the standard-rated line',
        near(invoice.data?.tax, 16), `tax=${invoice.data?.tax}`);
    check('invoice total follows', near(invoice.data?.total, 316), `total=${invoice.data?.total}`);
};

main()
    .catch(e => { console.error('FATAL', e); process.exitCode = 1; })
    .finally(async () => {
        await cleanup();
        await db.end().catch(() => {});
        const failed = results.filter(r => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        if (failed.length) {
            console.log('Failed:');
            for (const f of failed) console.log(`  - ${f.name}`);
            process.exitCode = 1;
        }
    });
