/**
 * Books accuracy (2026-11-16), end to end through the API.
 *
 *  - Opening stock from an import goes to owner's equity, not profit.
 *  - Each sale lands in the money account it was paid into (MTN → Mobile Money).
 *  - Statements are computed over the whole ledger: P&L, a balance sheet that
 *    balances, and a trial balance whose debits equal credits.
 *  - VAT report: output by class, less VAT paid on stock bought (input VAT).
 *  - Control accounts refuse manual journals; closed periods refuse postings.
 *  - Books health: ledger vs records all agree.
 *
 * Self-contained: seeds a throwaway store and user, and removes them after.
 *   node tests/books.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `books-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const SUPPLIER_ID = `sup-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'books-password-1';

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.006;
const pad = (n) => String(n).padStart(2, '0');
const day = (offset = 0) => { const d = new Date(Date.now() + offset * 86400000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const req = async (method, path, body, headers = {}) => {
    const r = await fetch(API + path, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
};

const db = new pg.Client({ connectionString: DATABASE_URL });

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`, [STORE_ID, `Books ${RUN}`]);
    await db.query(`INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified) VALUES ($1, 'Books Owner', $2, $3, 'admin', $4, true)`, [USER_ID, EMAIL, hash, STORE_ID]);
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled, enabled_modules)
         VALUES ($1, 'Books', 16, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, false, '{}')`, [STORE_ID]);
    await db.query(`INSERT INTO suppliers (id, name, store_id) VALUES ($1, 'Ndola Distributors', $2)`, [SUPPLIER_ID, STORE_ID]);
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
        const accounts = async () => (await req('GET', '/accounting/accounts', null, H)).data;
        const bySub = (list, sub) => list.find(a => a.subType === sub);

        // ── Opening stock via import → owner's equity ──
        const imp = await req('POST', '/products/import', { rows: [
            { name: 'Widget', sku: `W-${RUN}`, price: 100, costPrice: 60, stock: 10 },
            { name: 'Cooking Oil', sku: `O-${RUN}`, price: 10, costPrice: 5, stock: 0 },
        ] }, H);
        check('import accepted', imp.status === 200 || imp.status === 201, `status=${imp.status}`);
        let acc = await accounts();
        check('opening stock (10 × 60) is booked to owner\'s equity', near(bySub(acc, 'owner_equity')?.balance, 600), `equity=${bySub(acc, 'owner_equity')?.balance}`);
        check('…and not as stock-adjustment profit', near(bySub(acc, 'inventory_adjustment')?.balance || 0, 0), `adj=${bySub(acc, 'inventory_adjustment')?.balance}`);
        const widget = (await db.query('SELECT id FROM products WHERE store_id = $1 AND sku = $2', [STORE_ID, `W-${RUN}`])).rows[0].id;
        const oil = (await db.query('SELECT id FROM products WHERE store_id = $1 AND sku = $2', [STORE_ID, `O-${RUN}`])).rows[0].id;

        // ── Sales land in the account they were paid into ──
        const sale = (method) => req('POST', '/sales', {
            cart: [{ productId: widget, name: 'Widget', price: 100, quantity: 1 }],
            subtotal: 100, discount: 0, tax: 16, total: 116,
            paymentStatus: 'paid', amountPaid: 116, storeCreditUsed: 0,
            payments: [{ amount: 116, method }],
        }, H);
        const s1 = await sale('MTN Mobile Money');
        const s2 = await sale('Cash');
        check('two sales accepted', s1.status === 201 && s2.status === 201, `${s1.status} ${s2.status} ${JSON.stringify(s1.data).slice(0, 120)}`);
        acc = await accounts();
        check('the MTN sale is in Mobile Money (116)', near(bySub(acc, 'mobile_money')?.balance, 116), `momo=${bySub(acc, 'mobile_money')?.balance}`);
        check('the cash sale is in Cash (116)', near(bySub(acc, 'cash')?.balance, 116), `cash=${bySub(acc, 'cash')?.balance}`);

        // ── Buy stock with VAT on the bill → input VAT ──
        const po = await req('POST', '/purchase-orders', {
            id: `new_${Date.now()}`, poNumber: 'x', supplierId: SUPPLIER_ID, supplierName: 'Ndola Distributors', status: 'ordered',
            items: [{ productId: oil, productName: 'Cooking Oil', sku: 'O', quantity: 10, costPrice: 5, receivedQuantity: 0 }],
            createdAt: new Date().toISOString(), orderedAt: new Date().toISOString(), subtotal: 50, shippingCost: 0, tax: 8, total: 58,
        }, H);
        const rcv = await req('POST', `/purchase-orders/${po.data?.id}/receive`, [{ productId: oil, quantity: 10 }], H);
        check('stock order received', rcv.status === 200, `po=${po.status} receive=${rcv.status}`);
        acc = await accounts();
        check('the 8 VAT on the bill is recoverable input VAT', near(bySub(acc, 'vat_input')?.balance, 8), `vat_input=${bySub(acc, 'vat_input')?.balance}`);
        check('stock goes up by the goods only (600 − 120 + 50 = 530)', near(bySub(acc, 'inventory')?.balance, 530), `inventory=${bySub(acc, 'inventory')?.balance}`);

        // ── Statements over the whole ledger ──
        const st = (await req('GET', `/accounting/statements?from=${day(-1)}&to=${day()}&asOf=${day()}`, null, H)).data;
        const p = st.profitAndLoss;
        check('P&L: sales 200 (ex VAT)', near(p.totalRevenue, 200), `rev=${p.totalRevenue}`);
        check('P&L: cost of goods 120', near(p.totalCogs, 120), `cogs=${p.totalCogs}`);
        check('P&L: profit 80 (import did not count as profit)', near(p.netProfit, 80), `profit=${p.netProfit}`);
        check('balance sheet balances', st.balanceSheet.balanced, `diff=${st.balanceSheet.difference}`);
        check('trial balance: debits = credits', st.trialBalance.balanced && st.trialBalance.totalDebit > 0, `${st.trialBalance.totalDebit} / ${st.trialBalance.totalCredit}`);
        const past = (await req('GET', `/accounting/statements?from=${day(-1)}&to=${day()}&asOf=${day(-1)}`, null, H)).data;
        check('balance sheet as of yesterday shows nothing yet', near(past.balanceSheet.totalAssets, 0), `assets=${past.balanceSheet.totalAssets}`);

        // ── VAT ──
        const tax = (await req('GET', `/accounting/tax-report?from=${day(-1)}&to=${day()}`, null, H)).data;
        check('VAT charged on sales 32', near(tax.outputTax, 32), `output=${tax.outputTax}`);
        check('VAT paid on purchases 8', near(tax.inputTax, 8), `input=${tax.inputTax}`);
        check('VAT to pay 24', near(tax.netPayable, 24), `net=${tax.netPayable}`);

        // ── Journal page + account ledger ──
        const momo = bySub(acc, 'mobile_money');
        const jp = (await req('GET', `/accounting/journal?from=${day(-1)}&to=${day()}&accountId=${momo.id}`, null, H)).data;
        check('journal filtered to Mobile Money: one posting, balance after 116', jp.total === 1 && near(jp.items[0]?.accountBalanceAfter, 116), `total=${jp.total} after=${jp.items[0]?.accountBalanceAfter}`);
        const all = (await req('GET', `/accounting/journal?from=${day(-1)}&to=${day()}&limit=2`, null, H)).data;
        check('journal pages (limit 2 of more)', all.items.length === 2 && all.total > 2, `items=${all.items.length} total=${all.total}`);

        // ── Takings ──
        const tk = (await req('GET', `/accounting/takings?from=${day(-1)}&to=${day()}`, null, H)).data;
        const tm = tk.accounts.find(a => a.subType === 'mobile_money');
        check('takings: 116 in on Mobile Money', near(tm?.moneyIn, 116), JSON.stringify(tm));

        // ── Manual journals can't touch control accounts ──
        const ar = bySub(acc, 'accounts_receivable');
        const cash = bySub(acc, 'cash');
        const manual = await req('POST', '/accounting/journal-entries', {
            date: new Date().toISOString(), description: 'Fake debt',
            lines: [{ accountId: ar.id, accountName: ar.name, type: 'debit', amount: 10 }, { accountId: cash.id, accountName: cash.name, type: 'credit', amount: 10 }],
        }, H);
        check('manual journal to Accounts Receivable is refused', manual.status === 400, `status=${manual.status} ${manual.data?.message}`);

        // ── Health ──
        const h = (await req('GET', '/accounting/health', null, H)).data;
        check('books health: all checks agree', h.allOk === true, JSON.stringify(h.checks?.filter(c => !c.ok)));

        // ── Close the books ──
        const today = await req('PUT', '/accounting/lock', { lockedUntil: day() }, H);
        check('cannot close today or later', today.status === 400, `status=${today.status}`);
        const lock = await req('PUT', '/accounting/lock', { lockedUntil: day(-1) }, H);
        check('closing up to yesterday is accepted', lock.status === 200 && lock.data?.lockedUntil === day(-1), JSON.stringify(lock.data));
        const util = acc.find(a => a.number === '6030');
        const late = await req('POST', '/expenses', { date: day(-2), description: 'Old bill', amount: 20, expenseAccountId: util.id, paymentAccountId: cash.id, category: 'Utilities' }, H);
        check('an expense dated in the closed period is refused (409)', late.status === 409, `status=${late.status} ${late.data?.message}`);
        const now = await req('POST', '/expenses', { date: day(), description: 'Today bill', amount: 20, expenseAccountId: util.id, paymentAccountId: cash.id, category: 'Utilities' }, H);
        check('an expense dated today is still accepted', now.status === 201 || now.status === 200, `status=${now.status}`);
        const reopen = await req('PUT', '/accounting/lock', { lockedUntil: null }, H);
        check('books can be reopened', reopen.status === 200 && reopen.data?.lockedUntil === null, JSON.stringify(reopen.data));
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
