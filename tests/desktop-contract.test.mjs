/**
 * Verifies the desktop-contract fixes end-to-end against the local backend:
 *  1. POST /sales honors a client uuid transactionId and client timestamp.
 *  2. POST /returns referencing that client id succeeds (was 404 before).
 *  3. Return replay with the same X-Idempotency-Key does not double-restock.
 *  4. PATCH /products/:id/stock with mode:'absolute' sets stock exactly
 *     (reason 'Received shipment' used to be applied as a delta).
 *  5. temp_* transactionIds are still replaced server-side (web behavior).
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';
import { randomUUID } from 'crypto';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `ctrtest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const PRODUCT_ID = `prod-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'ctrtest-password-1';

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
    await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`, [STORE_ID, `Contract Test Store ${RUN}`]);
    await db.query(`INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified) VALUES ($1, 'Ctr Test Owner', $2, $3, 'admin', $4, true)`, [USER_ID, EMAIL, hash, STORE_ID]);
    await db.query(`INSERT INTO products (id, name, description, sku, price, cost_price, stock, status, store_id, image_urls) VALUES ($1, 'Contract Widget', 'contract test product', $2, 100.00, 60.00, 50, 'active', $3, '{}')`, [PRODUCT_ID, `CTR-${RUN}`, STORE_ID]);
};

const cleanup = async () => {
    for (const q of [
        [`DELETE FROM idempotency_keys WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM journal_lines WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM journal_entries WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM returns WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM payments WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM sale_items WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM sales WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM audit_logs WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM accounts WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM products WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM notifications WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM users WHERE id = $1`, [USER_ID]],
        [`DELETE FROM stores WHERE id = $1`, [STORE_ID]],
    ]) {
        try { await db.query(q[0], q[1]); } catch { /* table may not exist */ }
    }
};

const main = async () => {
    await db.connect();
    await seed();
    try {
        const login = await req('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
        const token = login.data?.token;
        if (!token) throw new Error(`login failed: ${JSON.stringify(login.data).slice(0, 200)}`);
        const auth = { Authorization: `Bearer ${token}` };

        // 1. Client uuid transactionId + old timestamp honored
        const clientId = randomUUID();
        const clientTs = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString();
        const sale = await req('POST', '/sales', {
            transactionId: clientId,
            timestamp: clientTs,
            cart: [{ productId: PRODUCT_ID, quantity: 2, price: 100 }],
            subtotal: 200, discount: 0, tax: 0, total: 200,
            paymentStatus: 'paid', amountPaid: 200,
            payments: [{ amount: 200, method: 'Cash' }],
        }, { ...auth, 'X-Idempotency-Key': clientId });
        check('client transactionId honored', sale.status === 201 && sale.data?.transactionId === clientId, `status=${sale.status} id=${sale.data?.transactionId}`);
        const tsRow = await db.query('SELECT "timestamp" FROM sales WHERE transaction_id = $1', [clientId]);
        const storedTs = new Date(tsRow.rows[0]?.timestamp || 0).getTime();
        check('client timestamp honored (±5s)', Math.abs(storedTs - new Date(clientTs).getTime()) < 5000, `stored=${tsRow.rows[0]?.timestamp?.toISOString?.() || tsRow.rows[0]?.timestamp} sent=${clientTs}`);

        // 5. temp_* id still replaced server-side
        const tempSale = await req('POST', '/sales', {
            transactionId: `temp_${Date.now()}_abc123`,
            cart: [{ productId: PRODUCT_ID, quantity: 1, price: 100 }],
            subtotal: 100, discount: 0, tax: 0, total: 100,
            paymentStatus: 'paid', amountPaid: 100,
        }, auth);
        check('temp_ id replaced with server id', tempSale.status === 201 && !String(tempSale.data?.transactionId || '').startsWith('temp_'), `id=${tempSale.data?.transactionId}`);

        // duplicate client id → 409 (desktop marks done, no dupe)
        const dupe = await req('POST', '/sales', {
            transactionId: clientId,
            cart: [{ productId: PRODUCT_ID, quantity: 1, price: 100 }],
            subtotal: 100, discount: 0, tax: 0, total: 100,
            paymentStatus: 'paid', amountPaid: 100,
        }, auth);
        check('duplicate client id → 409', dupe.status === 409, `status=${dupe.status}`);

        // 2+3. Return referencing the client id, idempotent replay
        const returnKey = randomUUID();
        const retBody = {
            originalSaleId: clientId,
            timestamp: new Date().toISOString(),
            returnedItems: [{ productId: PRODUCT_ID, productName: 'Contract Widget', quantity: 1, unitPrice: 100, reason: 'Changed mind', addToStock: true }],
            subtotalAmount: 100, taxAmount: 0, refundAmount: 100, refundMethod: 'Cash',
        };
        const ret = await req('POST', '/returns', retBody, { ...auth, 'X-Idempotency-Key': returnKey });
        check('return against client saleId accepted', ret.status === 201, `status=${ret.status} body=${JSON.stringify(ret.data).slice(0, 120)}`);

        const stockAfterReturn = await db.query('SELECT stock FROM products WHERE id = $1', [PRODUCT_ID]);
        const s1 = Number(stockAfterReturn.rows[0].stock);

        const retReplay = await req('POST', '/returns', retBody, { ...auth, 'X-Idempotency-Key': returnKey });
        const stockAfterReplay = await db.query('SELECT stock FROM products WHERE id = $1', [PRODUCT_ID]);
        const s2 = Number(stockAfterReplay.rows[0].stock);
        check('return replay does not double-restock', s1 === s2, `stock ${s1} -> ${s2} (replay status=${retReplay.status})`);

        // 4. mode:'absolute' stock adjustment
        const adj = await req('PATCH', `/products/${PRODUCT_ID}/stock`, { newQuantity: 80, reason: 'Received shipment', mode: 'absolute' }, auth);
        const stockAfterAdj = await db.query('SELECT stock FROM products WHERE id = $1', [PRODUCT_ID]);
        check("mode:'absolute' sets stock exactly", adj.status === 200 && Number(stockAfterAdj.rows[0].stock) === 80, `status=${adj.status} stock=${stockAfterAdj.rows[0].stock}`);

        // legacy delta behavior unchanged for reason-based adjustments
        const adjDelta = await req('PATCH', `/products/${PRODUCT_ID}/stock`, { newQuantity: -5, reason: 'Damage / Loss' }, auth);
        const stockAfterDelta = await db.query('SELECT stock FROM products WHERE id = $1', [PRODUCT_ID]);
        check('legacy delta reason still applies delta', adjDelta.status === 200 && Number(stockAfterDelta.rows[0].stock) === 75, `status=${adjDelta.status} stock=${stockAfterDelta.rows[0].stock}`);
    } finally {
        await cleanup();
        await db.end();
    }
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} contract checks pass`);
    process.exit(failed ? 1 : 0);
};

main().catch(e => { console.error(e); process.exit(1); });
