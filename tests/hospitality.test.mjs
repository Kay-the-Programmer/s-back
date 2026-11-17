/**
 * Hospitality: menu items, open bills, settling, end to end.
 *
 * Runs against a REAL backend + Postgres. What it covers is everything a unit
 * test cannot: that the new columns and tables exist, that the SQL is valid,
 * that stock moves for a counted drink and NOT for made-to-order food, that
 * two tills cannot charge one table twice, and that a shop which never turns
 * hospitality on is completely unaffected.
 *
 * Self-contained: seeds a throwaway store, user and menu, and removes them
 * afterwards, so it can run against any dev database.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/hospitality.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `hosptest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const OWNER_ID = `user-${RUN}`;
const STAFF_ID = `user-staff-${RUN}`;
// Food: made to order, holds no stock, must never block a sale.
const FOOD_ID = `prod-food-${RUN}`;
// Drink: counted normally, so settling a bill must move its stock.
const DRINK_ID = `prod-drink-${RUN}`;
const SECTION_ID = `cat-mains-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const STAFF_EMAIL = `staff-${RUN}@test.local`;
const PASSWORD = 'hosptest-password-1';

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
const stockOf = async (id) => {
    const r = await db.query('SELECT stock FROM products WHERE id = $1', [id]);
    return Number(r.rows[0]?.stock ?? NaN);
};

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status, business_types)
         VALUES ($1, $2, 'active', 'active', ARRAY['food_beverage'])`,
        [STORE_ID, `Hospitality Test ${RUN}`],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Venue Owner', $2, $3, 'admin', $4, true)`,
        [OWNER_ID, EMAIL, hash, STORE_ID],
    );
    // A waiter: holds tabs:operate but NOT tabs:void.
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Waiter', $2, $3, 'staff', $4, true)`,
        [STAFF_ID, STAFF_EMAIL, hash, STORE_ID],
    );
    // Tax off, so a figure that is wrong is wrong about stock or bills rather
    // than about rounding. Tax itself is covered by tests/till-and-tax.
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, business_mode)
         VALUES ($1, 'Hospitality Test', 0, '{"symbol":"K","code":"ZMW","position":"before"}', 5, false, 'hospitality')`,
        [STORE_ID],
    );
    await db.query(
        `INSERT INTO categories (id, name, attributes, store_id, sort_order)
         VALUES ($1, 'Main Courses', '[]', $2, 10)`,
        [SECTION_ID, STORE_ID],
    );
    // Deliberately at ZERO stock: a kitchen does not count steaks, and the
    // till must sell it anyway.
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, tax_class, category_id, track_stock)
         VALUES ($1, 'Beef Stew & Nshima', $2, 95.00, 40.00, 0, 'active', $3, '{}', 'standard', $4, false)`,
        [FOOD_ID, `FOOD-${RUN}`, STORE_ID, SECTION_ID],
    );
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, tax_class, track_stock)
         VALUES ($1, 'Mosi Lager 375ml', $2, 25.00, 15.00, 40, 'active', $3, '{}', 'standard', true)`,
        [DRINK_ID, `DRINK-${RUN}`, STORE_ID],
    );
};

const cleanup = async () => {
    const tables = [
        'journal_entry_lines', 'journal_entries', 'return_items', 'returns',
        'payments', 'sale_items', 'sales',
        'open_tab_items', 'open_tabs',
        'cash_movements', 'cash_sessions',
        'accounts', 'products', 'categories', 'audit_logs', 'store_settings',
    ];
    for (const t of tables) {
        await db.query(`DELETE FROM ${t} WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    }
    await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [[OWNER_ID, STAFF_ID]]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = $1', [STORE_ID]).catch(() => {});
};

const login = async (email) => {
    const r = await req('POST', '/auth/login', { email, password: PASSWORD });
    if (!r.data?.token) {
        console.error('FATAL: login failed for', email, r.status, JSON.stringify(r.data).slice(0, 300));
        process.exit(1);
    }
    return { Authorization: `Bearer ${r.data.token}` };
};

const main = async () => {
    await db.connect();
    await seed();

    const H = await login(EMAIL);
    const WAITER = await login(STAFF_EMAIL);

    // ------------------------------------------------- business mode ---

    const settings = await req('GET', '/settings', undefined, H);
    check('settings report hospitality mode',
        settings.data?.businessMode === 'hospitality', `businessMode=${settings.data?.businessMode}`);
    check('settings carry the business types for the venue\'s own wording',
        Array.isArray(settings.data?.businessTypes) && settings.data.businessTypes.includes('food_beverage'),
        JSON.stringify(settings.data?.businessTypes));

    // ------------------------------------------------- made-to-order ---

    // The whole point of track_stock: food at zero stock still sells, and
    // selling it moves nothing.
    const foodOnly = await req('POST', '/sales', {
        cart: [{ productId: FOOD_ID, name: 'Beef Stew & Nshima', price: 95, quantity: 2 }],
        subtotal: 190, discount: 0, tax: 0, total: 190,
        paymentStatus: 'paid', amountPaid: 190, storeCreditUsed: 0,
        payments: [{ amount: 190, method: 'Cash' }],
    }, H);
    check('a made-to-order item sells at zero stock', foodOnly.status === 201, `status=${foodOnly.status}`);
    check('selling it does not move stock', (await stockOf(FOOD_ID)) === 0, `stock=${await stockOf(FOOD_ID)}`);

    // Costing still works, which is what makes the food sellable AND reportable.
    const costed = await db.query(
        'SELECT cost_at_sale FROM sale_items WHERE sale_id = $1 AND product_id = $2',
        [foodOnly.data?.transactionId, FOOD_ID],
    );
    check('cost is still recorded on an untracked line',
        near(costed.rows[0]?.cost_at_sale, 40), `cost_at_sale=${costed.rows[0]?.cost_at_sale}`);

    // ------------------------------------------------------- open bills ---

    const opened = await req('POST', '/hospitality/tabs', {
        label: 'Table 4',
        items: [{ productId: DRINK_ID, quantity: 2 }],
    }, WAITER);
    check('a waiter can open a bill with its first round', opened.status === 201, `status=${opened.status}`);
    const tabId = opened.data?.id;
    check('the bill carries its running subtotal', near(opened.data?.subtotal, 50), `subtotal=${opened.data?.subtotal}`);

    const drinkStockWhileOpen = await stockOf(DRINK_ID);
    check('stock does not move while a bill is open', drinkStockWhileOpen === 40, `stock=${drinkStockWhileOpen}`);

    // Two waiters both opening "Table 4" would split one table's bill in half
    // without either noticing.
    const dupe = await req('POST', '/hospitality/tabs', { label: ' table 4 ' }, WAITER);
    check('a second bill with the same name is refused', dupe.status === 409, `status=${dupe.status}`);

    // A later round merges into the existing line, so the bill reads
    // "4 x Mosi" and not four separate lines.
    const round2 = await req('POST', `/hospitality/tabs/${tabId}/items`, {
        items: [{ productId: DRINK_ID, quantity: 2 }, { productId: FOOD_ID, quantity: 1 }],
    }, WAITER);
    check('a second round is added', round2.status === 200, `status=${round2.status}`);
    check('a repeat item merges into one line',
        round2.data?.items?.length === 2, `lines=${round2.data?.items?.length}`);
    check('the running total follows', near(round2.data?.subtotal, 195), `subtotal=${round2.data?.subtotal}`);

    // The price on the bill is the server's, never the client's.
    const sneaky = await req('POST', `/hospitality/tabs/${tabId}/items`, {
        items: [{ productId: DRINK_ID, quantity: 1, price: 0.01 }],
    }, WAITER);
    const cheekyLine = (sneaky.data?.items || []).find(i => i.productId === DRINK_ID);
    check('a client cannot name its own price on a bill',
        near(cheekyLine?.price, 25), `price=${cheekyLine?.price}`);

    // ---------------------------------------------------------- settling ---

    const claim = await req('POST', `/hospitality/tabs/${tabId}/claim`, {}, WAITER);
    check('a till can claim the bill to take payment', claim.status === 200, `status=${claim.status}`);

    // The second till loses the race rather than charging the table twice.
    const claim2 = await req('POST', `/hospitality/tabs/${tabId}/claim`, {}, H);
    check('a second till cannot claim the same bill', claim2.status === 409, `status=${claim2.status}`);

    // A claimed bill is closed to additions, so a round cannot slip in after
    // the sale was totalled.
    const lateRound = await req('POST', `/hospitality/tabs/${tabId}/items`, {
        items: [{ productId: DRINK_ID, quantity: 1 }],
    }, WAITER);
    check('a claimed bill takes no more items', lateRound.status === 409, `status=${lateRound.status}`);

    // Settled through the ORDINARY sale path — the one authority on totals,
    // tax, stock, COGS and the journals.
    const sale = await req('POST', '/sales', {
        cart: [
            { productId: DRINK_ID, name: 'Mosi Lager 375ml', price: 25, quantity: 5 },
            { productId: FOOD_ID, name: 'Beef Stew & Nshima', price: 95, quantity: 1 },
        ],
        subtotal: 220, discount: 0, tax: 0, total: 220,
        paymentStatus: 'paid', amountPaid: 220, storeCreditUsed: 0,
        payments: [{ amount: 220, method: 'Cash' }],
        tabLabel: 'Table 4',
    }, WAITER);
    check('the bill is settled by an ordinary sale', sale.status === 201, `status=${sale.status}`);
    const saleId = sale.data?.transactionId;

    check('only the counted line moved stock', (await stockOf(DRINK_ID)) === 35, `drink=${await stockOf(DRINK_ID)}`);
    check('the made-to-order line still moved nothing', (await stockOf(FOOD_ID)) === 0, `food=${await stockOf(FOOD_ID)}`);

    const labelled = await db.query('SELECT tab_label FROM sales WHERE transaction_id = $1', [saleId]);
    check('the sale remembers which bill it came off',
        labelled.rows[0]?.tab_label === 'Table 4', `tab_label=${labelled.rows[0]?.tab_label}`);

    const closed = await req('POST', `/hospitality/tabs/${tabId}/close`, { saleId }, WAITER);
    check('closing the bill against the sale succeeds', closed.status === 200, `status=${closed.status}`);
    check('the bill is marked closed', closed.data?.status === 'closed', `status=${closed.data?.status}`);

    // A retried close for the SAME sale is treated as done, so a lost response
    // mid-payment does not alarm the cashier.
    const closeAgain = await req('POST', `/hospitality/tabs/${tabId}/close`, { saleId }, WAITER);
    check('re-closing against the same sale is accepted', closeAgain.status === 200, `status=${closeAgain.status}`);

    // Closing it against a DIFFERENT sale is not.
    const closeOther = await req('POST', `/hospitality/tabs/${tabId}/close`, {
        saleId: foodOnly.data?.transactionId,
    }, WAITER);
    check('re-closing against a different sale is refused', closeOther.status === 409, `status=${closeOther.status}`);

    // A bill cannot be closed against a sale that does not exist, or money
    // could be taken with no record of which sale took it.
    const ghost = await req('POST', '/hospitality/tabs', { label: 'Table 9' }, WAITER);
    const ghostClose = await req('POST', `/hospitality/tabs/${ghost.data?.id}/close`, {
        saleId: 'SALE-does-not-exist',
    }, WAITER);
    check('a bill cannot be closed against a sale that does not exist',
        ghostClose.status === 400, `status=${ghostClose.status}`);

    // The settled bill is off the floor; the un-settled one is still on it.
    const live = await req('GET', '/hospitality/tabs?status=live', undefined, WAITER);
    const liveLabels = (live.data || []).map(t => t.label);
    check('a settled bill leaves the floor', !liveLabels.includes('Table 4'), liveLabels.join(', '));
    check('an open bill stays on the floor', liveLabels.includes('Table 9'), liveLabels.join(', '));

    // Writing off an unpaid bill is a manager's call, not a waiter's.
    const waiterVoid = await req('POST', `/hospitality/tabs/${ghost.data?.id}/void`, { reason: 'walked out' }, WAITER);
    check('a waiter cannot write a bill off', waiterVoid.status === 403, `status=${waiterVoid.status}`);

    const noReason = await req('POST', `/hospitality/tabs/${ghost.data?.id}/void`, {}, H);
    check('a write-off needs a reason', noReason.status === 400, `status=${noReason.status}`);

    const voided = await req('POST', `/hospitality/tabs/${ghost.data?.id}/void`, { reason: 'walked out' }, H);
    check('a manager can write a bill off', voided.status === 200, `status=${voided.status}`);
    check('the reason is kept', voided.data?.voidReason === 'walked out', `reason=${voided.data?.voidReason}`);

    // Releasing a stranded claim, so a dropped connection mid-payment does not
    // leave a table nobody can add to or pay.
    const stranded = await req('POST', '/hospitality/tabs', {
        label: 'Table 12', items: [{ productId: DRINK_ID, quantity: 1 }],
    }, WAITER);
    await req('POST', `/hospitality/tabs/${stranded.data?.id}/claim`, {}, WAITER);
    const released = await req('POST', `/hospitality/tabs/${stranded.data?.id}/release`, {}, WAITER);
    check('a stranded claim can be given back', released.data?.status === 'open', `status=${released.data?.status}`);

    const addAfterRelease = await req('POST', `/hospitality/tabs/${stranded.data?.id}/items`, {
        items: [{ productId: DRINK_ID, quantity: 1 }],
    }, WAITER);
    check('a released bill takes items again', addAfterRelease.status === 200, `status=${addAfterRelease.status}`);

    // ------------------------------------------------------ refunds ---

    // The restore has to be symmetrical with the sale: an item that never left
    // stock must not be put back, or a refunded plate of food invents
    // inventory.
    const refund = await req('POST', '/returns', {
        originalSaleId: saleId,
        refundAmount: 120,
        refundMethod: 'Cash',
        returnedItems: [
            { productId: DRINK_ID, productName: 'Mosi Lager 375ml', quantity: 1, reason: 'Wrong item', addToStock: true },
            { productId: FOOD_ID, productName: 'Beef Stew & Nshima', quantity: 1, reason: 'Wrong item', addToStock: true },
        ],
    }, H);
    if (refund.status === 201) {
        check('refund restocks the counted drink', (await stockOf(DRINK_ID)) === 36, `drink=${await stockOf(DRINK_ID)}`);
        check('refund does not restock made-to-order food',
            (await stockOf(FOOD_ID)) === 0, `food=${await stockOf(FOOD_ID)}`);
    } else {
        check('refund accepted', false, `status=${refund.status} ${JSON.stringify(refund.data).slice(0, 160)}`);
    }

    // --------------------------------------------- menu sections order ---

    const cats = await req('GET', '/categories', undefined, H);
    const mains = (cats.data || []).find(c => c.id === SECTION_ID);
    check('a section carries its menu position', Number(mains?.sortOrder) === 10, `sortOrder=${mains?.sortOrder}`);

    const added = await req('POST', '/categories', { name: `Desserts ${RUN}`, parentId: null, attributes: [] }, H);
    check('a new section is appended, not put first',
        Number(added.data?.sortOrder) > 10, `sortOrder=${added.data?.sortOrder}`);

    const reorder = await req('PATCH', '/categories/reorder', {
        ids: [added.data?.id, SECTION_ID],
    }, H);
    check('sections can be reordered in one call', reorder.status === 200, `status=${reorder.status}`);
    const after = await req('GET', '/categories', undefined, H);
    const order = (after.data || []).filter(c => [SECTION_ID, added.data?.id].includes(c.id)).map(c => c.id);
    check('the new order is what the till reads',
        order[0] === added.data?.id && order[1] === SECTION_ID, order.join(' → '));

    // ---------------------------------------- a shop is left untouched ---

    // Retail is the default, and nothing about this feature may change it: a
    // product created without saying anything about stock still counts it.
    const plain = await req('POST', '/products', {
        name: `Plain Product ${RUN}`, sku: `PLAIN-${RUN}`, price: 10, stock: 7, status: 'active',
    }, H);
    check('a product created without mentioning stock still counts it',
        plain.data?.trackStock !== false, `trackStock=${plain.data?.trackStock}`);

    // And editing it without mentioning the flag does not flip it.
    const keptOff = await req('PUT', `/products/${FOOD_ID}`, { price: 99 }, H);
    check('editing a made-to-order item does not switch counting back on',
        keptOff.data?.trackStock === false, `trackStock=${keptOff.data?.trackStock}`);
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
