/**
 * Receiving stock against a purchase order can never count the same goods twice.
 *
 * The bug: POST /purchase-orders/:id/receive added whatever it was sent. A
 * double tap, or a second tap on an order the screen still showed as open,
 * booked the delivery again — stock, received quantity and the journal all
 * doubled. The endpoint now locks the order, caps every line at what is still
 * outstanding, and refuses an order that is already received or cancelled.
 *
 * Self-contained: seeds a throwaway store and user, and removes them after.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/po-receive.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `porecv-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const SUPPLIER_ID = `sup-${RUN}`;
const UNIT_ID = `prod-unit-${RUN}`;
const KG_ID = `prod-kg-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'porecv-password-1';

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
const stockOf = async (id) => Number((await db.query('SELECT stock FROM products WHERE id = $1', [id])).rows[0].stock);
const receivedOf = async (poId, productId) => Number((await db.query(
    'SELECT received_quantity FROM purchase_order_items WHERE po_id = $1 AND product_id = $2', [poId, productId],
)).rows[0].received_quantity);
const receptionEntries = async (poNumber) => Number((await db.query(
    `SELECT count(*) FROM journal_entries WHERE store_id = $1 AND description = $2`, [STORE_ID, `Received stock for PO ${poNumber}`],
)).rows[0].count);

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`, [STORE_ID, `PO Receive Test ${RUN}`]);
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Receive Test Owner', $2, $3, 'admin', $4, true)`,
        [USER_ID, EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled, enabled_modules)
         VALUES ($1, 'PO Receive Test', 0, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, false, '{}')`,
        [STORE_ID],
    );
    await db.query(`INSERT INTO suppliers (id, name, store_id) VALUES ($1, 'Kitwe Traders', $2)`, [SUPPLIER_ID, STORE_ID]);
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, supplier_id, unit_of_measure)
         VALUES ($1, 'Soap Bar', $2, 10, 5, 10, 'active', $3, '{}', $4, 'unit')`,
        [UNIT_ID, `U-${RUN}`, STORE_ID, SUPPLIER_ID],
    );
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, supplier_id, unit_of_measure)
         VALUES ($1, 'Rice (loose)', $2, 30, 20, 1.25, 'active', $3, '{}', $4, 'kg')`,
        [KG_ID, `K-${RUN}`, STORE_ID, SUPPLIER_ID],
    );
};

// Every table carrying this store's rows, deleted over a few passes so foreign
// keys between them sort themselves out.
const cleanup = async () => {
    const { rows } = await db.query(
        `SELECT table_name FROM information_schema.columns WHERE column_name = 'store_id' AND table_schema = 'public'`,
    );
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
        if (!login.data?.token) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
        const H = { Authorization: `Bearer ${login.data.token}` };

        const placeOrder = async (lines) => {
            const r = await req('POST', '/purchase-orders', {
                id: `new_${Date.now()}`, poNumber: 'x', supplierId: SUPPLIER_ID, supplierName: 'Kitwe Traders', status: 'ordered',
                items: lines.map(([productId, quantity, costPrice]) => ({ productId, productName: productId, sku: productId, quantity, costPrice, receivedQuantity: 0 })),
                createdAt: new Date().toISOString(), orderedAt: new Date().toISOString(), subtotal: 0, shippingCost: 0, tax: 0, total: 0,
            }, H);
            if (r.status !== 201 && r.status !== 200) throw new Error(`could not place order: ${r.status}`);
            return r.data;
        };
        const receive = (poId, items) => req('POST', `/purchase-orders/${poId}/receive`, items, H);

        // ── 1. The reported bug: the same delivery sent twice at once ──
        const po1 = await placeOrder([[UNIT_ID, 10, 5]]);
        const [a, b] = await Promise.all([
            receive(po1.id, [{ productId: UNIT_ID, quantity: 10 }]),
            receive(po1.id, [{ productId: UNIT_ID, quantity: 10 }]),
        ]);
        const statuses = [a.status, b.status].sort();
        check('two simultaneous receipts: one books, one is refused', statuses[0] === 200 && statuses[1] === 409, `statuses=${statuses}`);
        check('stock went up once (10 → 20), not twice', await stockOf(UNIT_ID) === 20, `stock=${await stockOf(UNIT_ID)}`);
        check('the order line shows 10 received, not 20', await receivedOf(po1.id, UNIT_ID) === 10);
        check('one reception journal entry, not two', await receptionEntries(po1.poNumber) === 1, `entries=${await receptionEntries(po1.poNumber)}`);

        // ── 2. A late second tap on an already-received order ──
        const again = await receive(po1.id, [{ productId: UNIT_ID, quantity: 10 }]);
        check('receiving a fully received order is refused (409)', again.status === 409, `status=${again.status}`);
        check('…and the refusal says so in words', /already been fully received/i.test(again.data?.message || ''), again.data?.message);
        check('…and stock is unchanged', await stockOf(UNIT_ID) === 20);

        // ── 3. More than was ordered is capped at what is outstanding ──
        const po2 = await placeOrder([[UNIT_ID, 4, 5]]);
        const over = await receive(po2.id, [{ productId: UNIT_ID, quantity: 9 }]);
        check('over-receiving is accepted but capped', over.status === 200 && over.data?.capped === true, `status=${over.status} capped=${over.data?.capped}`);
        check('only the 4 outstanding were added (20 → 24)', await stockOf(UNIT_ID) === 24, `stock=${await stockOf(UNIT_ID)}`);
        check('the order is marked received', over.data?.status === 'received', over.data?.status);

        // ── 4. Partial receipts add up, and weighed goods keep their decimals ──
        const po3 = await placeOrder([[KG_ID, 3.5, 20]]);
        const part1 = await receive(po3.id, [{ productId: KG_ID, quantity: 1.25 }]);
        check('a partial receipt leaves the order partially received', part1.data?.status === 'partially_received', part1.data?.status);
        check('1.25 kg is booked exactly (1.25 → 2.50)', Math.abs(await stockOf(KG_ID) - 2.5) < 0.001, `stock=${await stockOf(KG_ID)}`);
        // Repeated lines in one request are merged before capping.
        const part2 = await receive(po3.id, [{ productId: KG_ID, quantity: 2 }, { productId: KG_ID, quantity: 2 }]);
        check('the rest is capped at 2.25 kg outstanding', part2.status === 200 && Math.abs(await receivedOf(po3.id, KG_ID) - 3.5) < 0.001,
            `received=${await receivedOf(po3.id, KG_ID)}`);
        check('stock ends at 1.25 + 3.5 = 4.75 kg', Math.abs(await stockOf(KG_ID) - 4.75) < 0.001, `stock=${await stockOf(KG_ID)}`);

        // ── 5. Nothing real to receive ──
        const po4 = await placeOrder([[UNIT_ID, 5, 5]]);
        const junk = await receive(po4.id, [{ productId: UNIT_ID, quantity: -3 }, { productId: 'not-on-this-order', quantity: 5 }]);
        check('negative amounts and products not on the order book nothing (409)', junk.status === 409, `status=${junk.status}`);
        check('…and stock is untouched', await stockOf(UNIT_ID) === 24);
        const notList = await receive(po4.id, { productId: UNIT_ID, quantity: 1 });
        check('a body that is not a list is a 400', notList.status === 400, `status=${notList.status}`);

        // ── 6. A cancelled order cannot be received ──
        await db.query(`UPDATE purchase_orders SET status = 'canceled' WHERE id = $1`, [po4.id]);
        const cancelled = await receive(po4.id, [{ productId: UNIT_ID, quantity: 5 }]);
        check('a cancelled order is refused (409)', cancelled.status === 409, `status=${cancelled.status}`);
        check('…and stock is untouched', await stockOf(UNIT_ID) === 24);
    } finally {
        await cleanup();
        await db.end();
    }

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log('Failed:');
        failed.forEach(f => console.log(`  - ${f.name}`));
        process.exit(1);
    }
};

main().catch(async (err) => {
    console.error('FATAL', err);
    try { await cleanup(); await db.end(); } catch { /* ignore */ }
    process.exit(1);
});
