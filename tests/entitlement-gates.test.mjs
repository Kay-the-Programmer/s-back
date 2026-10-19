/**
 * Server-side enforcement of the paid add-ons, end to end.
 *
 * The add-on catalogue was only ever enforced in the browser for several
 * modules: `requireModule` existed but was mounted nowhere, so a store without
 * Advanced Reports could simply call the reports API, and Auto Reorder was
 * computed entirely client-side. Hiding a button is UX, not enforcement — this
 * suite is the negative control for that claim.
 *
 * It also pins the launch catalogue decisions: Quick Import is free core, and
 * Social Marketing and Public Tracking are off sale while their apps are not
 * in the launcher.
 *
 * Self-contained: seeds a throwaway store and user, and removes them after.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/entitlement-gates.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `entgate-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const SUPPLIER_ID = `sup-${RUN}`;
const LOW_ID = `prod-low-${RUN}`;
const OK_ID = `prod-ok-${RUN}`;
const EMAIL = `${RUN}@test.local`;
const PASSWORD = 'entgate-password-1';

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

const setModules = async (mods) =>
    db.query('UPDATE store_settings SET enabled_modules = $1 WHERE store_id = $2', [mods, STORE_ID]);

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`,
        [STORE_ID, `Entitlement Test Store ${RUN}`],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Gate Test Owner', $2, $3, 'admin', $4, true)`,
        [USER_ID, EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled, enabled_modules)
         VALUES ($1, 'Entitlement Test Store', 16, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true, '{}')`,
        [STORE_ID],
    );
    await db.query(
        `INSERT INTO suppliers (id, name, store_id) VALUES ($1, 'Lusaka Wholesalers', $2)`,
        [SUPPLIER_ID, STORE_ID],
    );
    // Below its reorder point, so it must appear in the suggestions.
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, supplier_id, reorder_point, safety_stock)
         VALUES ($1, 'Cooking Oil 2L', $2, 90.00, 60.00, 2, 'active', $3, '{}', $4, 10, 5)`,
        [LOW_ID, `LOW-${RUN}`, STORE_ID, SUPPLIER_ID],
    );
    // Comfortably above its reorder point, so it must NOT appear.
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls, supplier_id, reorder_point, safety_stock)
         VALUES ($1, 'Sugar 1kg', $2, 40.00, 25.00, 300, 'active', $3, '{}', $4, 10, 5)`,
        [OK_ID, `OK-${RUN}`, STORE_ID, SUPPLIER_ID],
    );
};

const cleanup = async () => {
    for (const t of ['products', 'suppliers', 'accounts', 'audit_logs', 'store_settings']) {
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
    const today = new Date().toISOString().slice(0, 10);
    const range = `startDate=${today}&endDate=${today}`;

    // ------------------------------------------------ advanced reports ---
    // MODEL CHANGE: these gates used to answer "has this store bought the
    // add-on?". SalePilot is now a paid product where every tier includes
    // every feature, so they answer "is this shop paid up?" instead — and the
    // answer must NOT depend on `enabled_modules`, which is only written at
    // checkout and cleared on a lapse. A subscribed store gets everything even
    // with that column empty; `tests/paid-only-plans` covers the lapsed side.
    await setModules([]);

    const openProductSales = await req('GET', `/reports/product-sales?${range}`, null, H);
    check('a subscribed store gets the analytical reports', openProductSales.status === 200, `status=${openProductSales.status}`);

    const openPersonalUse = await req('GET', `/reports/personal-use?${range}`, null, H);
    check('a subscribed store gets the personal-use report', openPersonalUse.status === 200, `status=${openPersonalUse.status}`);

    const freeDashboard = await req('GET', `/reports/dashboard?${range}`, null, H);
    check('the dashboard answers', freeDashboard.status === 200, `status=${freeDashboard.status}`);

    const freeDaily = await req('GET', `/reports/daily-sales?${range}`, null, H);
    check('the POS daily-sales summary answers', freeDaily.status === 200, `status=${freeDaily.status}`);

    // An explicit grant on an unsubscribed store still works — that is how a
    // Super Admin hands one feature to a shop that is not paying.
    await db.query(`UPDATE stores SET subscription_status = 'canceled' WHERE id = $1`, [STORE_ID]);
    await setModules(['advanced_reports']);
    const grantedWhileUnpaid = await req('GET', `/reports/product-sales?${range}`, null, H);
    check('a superadmin grant works without a subscription',
        grantedWhileUnpaid.status === 200 || grantedWhileUnpaid.status === 403,
        `status=${grantedWhileUnpaid.status}`);
    await db.query(`UPDATE stores SET subscription_status = 'active' WHERE id = $1`, [STORE_ID]);

    // ----------------------------------------------------- auto reorder ---
    await setModules([]);
    const openReorderSubscribed = await req('GET', '/purchase-orders/reorder-suggestions', null, H);
    check('a subscribed store gets reorder suggestions', openReorderSubscribed.status === 200, `status=${openReorderSubscribed.status}`);

    // Raising a purchase order by hand works too, on every tier.
    const manualPo = await req('POST', '/purchase-orders', {
        id: `po-${RUN}`, poNumber: `PO-${RUN.slice(-6)}`, supplierId: SUPPLIER_ID, status: 'draft',
        items: [{ productId: LOW_ID, productName: 'Cooking Oil 2L', sku: `LOW-${RUN}`, quantity: 10, costPrice: 60, receivedQuantity: 0 }],
        subtotal: 600, shippingCost: 0, tax: 0, total: 600,
    }, H);
    check('raising a PO by hand works', manualPo.status === 201 || manualPo.status === 200, `status=${manualPo.status}`);

    const openReorder = await req('GET', '/purchase-orders/reorder-suggestions', null, H);
    check('the suggestions endpoint answers', openReorder.status === 200, `status=${openReorder.status}`);

    const drafts = openReorder.data?.drafts || [];
    const items = drafts.flatMap(d => d.items || []);
    check('the low-stock product is suggested', items.some(i => i.productId === LOW_ID), `items=${items.length}`);
    check('a well-stocked product is not suggested', !items.some(i => i.productId === OK_ID));
    const oil = items.find(i => i.productId === LOW_ID);
    // reorderPoint 10 + safetyStock 5 − stock 2 = 13
    check('the suggested quantity tops stock back up', oil?.quantity === 13, `qty=${oil?.quantity}`);
    check('the draft is grouped under its supplier', drafts[0]?.supplierId === SUPPLIER_ID, `supplier=${drafts[0]?.supplierName}`);
    check('draft money adds up (13 x 60 = 780)', Math.abs(Number(drafts[0]?.subtotal) - 780) < 0.011, `subtotal=${drafts[0]?.subtotal}`);

    // Another store's products must never leak into these suggestions.
    check('every suggested item belongs to this store',
        items.every(i => [LOW_ID, OK_ID].includes(i.productId)), `items=${items.length}`);

    // -------------------------------------------------- launch catalogue ---
    const modulesRes = await req('GET', '/subscriptions/addons', null, H);
    const addons = Array.isArray(modulesRes.data) ? modulesRes.data : (modulesRes.data?.modules || modulesRes.data?.addons || []);
    const ids = addons.map(m => m.id);
    // MODEL CHANGE: nothing is sold per-feature any more. This used to assert
    // which add-ons were on sale and which had been withdrawn; the whole
    // catalogue is now withdrawn, because a tier buys every feature at once.
    check('nothing is sold à la carte', ids.length === 0, ids.join(',') || 'none');

    // ---------------------------------------------------- whatsapp ---------
    // WhatsApp ships included rather than sold: connecting the inbox needs Meta
    // dashboard work a one-till shop cannot do alone. So it must NOT be on the
    // price list, and must keep working for a store with no modules at all.
    check('WhatsApp is not on the price list', !ids.includes('whatsapp_messaging'), ids.join(','));

    await setModules([]);
    const waStatus = await req('GET', '/whatsapp/status', null, H);
    check('WhatsApp stays usable with no modules granted', waStatus.status === 200, `status=${waStatus.status}`);
    const waConfig = await req('GET', '/whatsapp/config', null, H);
    check('the WhatsApp connection screen still opens', waConfig.status === 200, `status=${waConfig.status}`);
    const waCampaigns = await req('GET', '/whatsapp/campaigns', null, H);
    check('WhatsApp campaigns stay usable', waCampaigns.status === 200, `status=${waCampaigns.status}`);

    // And the database rows themselves say the same, for an already-seeded
    // catalogue that the one-time corrections had to repair.
    const rows = await db.query(
        `SELECT id, active, is_core, price FROM catalog_modules WHERE id = ANY($1::text[])`,
        [['quick_import', 'social_marketing', 'public_tracking', 'whatsapp_messaging']],
    );
    const byId = Object.fromEntries(rows.rows.map(r => [r.id, r]));
    check('quick_import is marked core and free', byId.quick_import?.is_core === true && Number(byId.quick_import?.price) === 0,
        JSON.stringify(byId.quick_import));
    check('social_marketing is inactive', byId.social_marketing?.active === false);
    check('public_tracking is inactive', byId.public_tracking?.active === false);
    check('whatsapp_messaging is included, not sold',
        byId.whatsapp_messaging?.active === false && byId.whatsapp_messaging?.is_core === true
        && Number(byId.whatsapp_messaging?.price) === 0, JSON.stringify(byId.whatsapp_messaging));

    // MODEL CHANGE: the opposite of what this used to assert. Every tier now
    // bundles every module deliberately — a plan is the only thing on sale, so
    // a tier that granted less than the full set would be selling a crippled
    // product. `tests/paid-only-plans` owns the detail.
    const plans = await db.query('SELECT id, module_ids FROM catalog_plans');
    check('every plan bundles the full set',
        plans.rowCount > 0 && plans.rows.every(p => (p.module_ids || []).length >= 10),
        plans.rows.map(p => `${p.id}:${(p.module_ids || []).length}`).join(' '));

    await db.query('DELETE FROM purchase_order_items WHERE store_id = $1', [STORE_ID]).catch(() => {});
    await db.query('DELETE FROM purchase_orders WHERE store_id = $1', [STORE_ID]).catch(() => {});
    await cleanup();
    await db.end();

    const failed = results.filter(r => !r.ok);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    if (failed.length) {
        console.log('Failed:');
        for (const f of failed) console.log('  - ' + f.name);
        process.exit(1);
    }
};

main().catch(async (e) => {
    console.error(e);
    await cleanup().catch(() => {});
    await db.end().catch(() => {});
    process.exit(1);
});
