/**
 * Bulk CSV product import, end-to-end against the local backend.
 *
 * What this pins down:
 *  1. A dry run reports exactly what would happen and writes nothing.
 *  2. Good rows import; bad rows are reported per line without killing the batch.
 *  3. Prices/stock are re-validated server-side (the browser isn't trusted).
 *  4. Duplicates — already in the catalogue, or repeated inside the file — are
 *     skipped by default and updated only when asked.
 *  5. Categories are created from the file by name.
 *  6. An unexpected failure leaves the catalogue untouched (one transaction).
 *  7. Tenant isolation and the freemium product cap both hold.
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `imptest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const ADMIN_ID = `user-admin-${RUN}`;
const STAFF_ID = `user-staff-${RUN}`;
const PASSWORD = 'imptest-password-1';

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
    await db.query(`INSERT INTO stores (id, name, status, subscription_status) VALUES ($1,$2,'active','active')`,
        [STORE_ID, `Import Store ${RUN}`]);
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, enabled_modules)
         VALUES ($1,$2,0,'{"symbol":"K","code":"ZMW","position":"before"}'::jsonb,5,true, ARRAY['unlimited_products'])`,
        [STORE_ID, `Import Store ${RUN}`],
    );
    for (const [id, name, email, role] of [
        [ADMIN_ID, 'Import Owner', `admin-${RUN}@test.local`, 'admin'],
        [STAFF_ID, 'Import Cashier', `staff-${RUN}@test.local`, 'staff'],
    ]) {
        await db.query(
            `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
             VALUES ($1,$2,$3,$4,$5,$6,true)`,
            [id, name, email, hash, role, STORE_ID],
        );
    }
};

const cleanup = async () => {
    for (const q of [
        [`DELETE FROM products WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM categories WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM audit_logs WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM store_settings WHERE store_id = $1`, [STORE_ID]],
        [`DELETE FROM users WHERE current_store_id = $1`, [STORE_ID]],
        [`DELETE FROM stores WHERE id = $1`, [STORE_ID]],
    ]) {
        try { await db.query(q[0], q[1]); } catch { /* ignore */ }
    }
};

const login = async (email) => {
    const r = await req('POST', '/auth/login', { email, password: PASSWORD });
    if (r.status !== 200 || !r.data?.token) throw new Error(`login failed for ${email}: ${r.status}`);
    return { Authorization: `Bearer ${r.data.token}` };
};

const countProducts = async () => {
    const r = await db.query('SELECT COUNT(*)::int AS n FROM products WHERE store_id = $1', [STORE_ID]);
    return r.rows[0].n;
};

const run = async () => {
    await db.connect();
    await cleanup();
    await seed();

    const admin = await login(`admin-${RUN}@test.local`);
    const staff = await login(`staff-${RUN}@test.local`);

    const goodRows = [
        { name: 'Imported Rice 5kg', sku: `IMP-RICE-${RUN}`, category: 'Groceries', price: '120.50', costPrice: '90', stock: '25' },
        { name: 'Imported Cooking Oil', sku: `IMP-OIL-${RUN}`, category: 'Groceries', price: 85, stock: 10 },
        { name: 'Imported Soap', category: 'Toiletries', price: '15', stock: '100', unitOfMeasure: 'unit' },
    ];

    // 1. Dry run writes nothing.
    const before = await countProducts();
    const dry = await req('POST', '/products/import', { rows: goodRows, dryRun: true }, admin);
    check('dry run is accepted', dry.status === 200, `status ${dry.status} ${JSON.stringify(dry.data).slice(0, 120)}`);
    check('dry run reports what would happen', dry.data?.created === 3 && dry.data?.errors === 0,
        `created=${dry.data?.created} errors=${dry.data?.errors}`);
    check('dry run writes nothing', (await countProducts()) === before, `count ${before} -> ${await countProducts()}`);

    // 2 + 3. Real import, mixing good rows with bad ones.
    const mixed = [
        ...goodRows,
        { name: '', price: '10' },                                   // no name
        { name: 'No Price Item', category: 'Groceries' },            // no price
        { name: 'Negative Stock', price: '10', stock: '-5' },        // bad stock
        { name: 'Zero Price', price: '0' },                          // non-positive price
        { name: 'Not A Number', price: 'abc' },                      // unparseable
    ];
    const imported = await req('POST', '/products/import', { rows: mixed }, admin);
    check('import succeeds with a mix of good and bad rows', imported.status === 200, `status ${imported.status}`);
    check('the three good rows were created', imported.data?.created === 3, `created=${imported.data?.created}`);
    check('the five bad rows were rejected, not imported', imported.data?.errors === 5, `errors=${imported.data?.errors}`);
    check('every rejection names its line and reason',
        (imported.data?.outcomes || []).filter(o => o.action === 'error').every(o => o.row > 0 && !!o.message),
        JSON.stringify((imported.data?.outcomes || []).find(o => o.action === 'error')));
    check('only the good rows reached the database', (await countProducts()) === 3, `count=${await countProducts()}`);

    const rice = await db.query('SELECT * FROM products WHERE store_id = $1 AND sku = $2', [STORE_ID, `IMP-RICE-${RUN}`]);
    check('values are stored as numbers, not strings',
        Number(rice.rows[0].price) === 120.5 && Number(rice.rows[0].cost_price) === 90 && Number(rice.rows[0].stock) === 25,
        `price=${rice.rows[0].price} cost=${rice.rows[0].cost_price} stock=${rice.rows[0].stock}`);

    // 5. Categories created from the file.
    const cats = await db.query('SELECT name FROM categories WHERE store_id = $1 ORDER BY name', [STORE_ID]);
    check('categories named in the file were created',
        cats.rows.map(c => c.name).join(',') === 'Groceries,Toiletries',
        cats.rows.map(c => c.name).join(','));

    const soap = await db.query("SELECT sku FROM products WHERE store_id = $1 AND name = 'Imported Soap'", [STORE_ID]);
    check('a row with no SKU gets one generated', !!soap.rows[0].sku && soap.rows[0].sku.startsWith('IMP-'), soap.rows[0].sku);

    // 4. Duplicates.
    const again = await req('POST', '/products/import', { rows: goodRows }, admin);
    check('re-importing the same file creates nothing', again.data?.created === 0 && again.data?.skipped === 3,
        `created=${again.data?.created} skipped=${again.data?.skipped}`);
    check('re-import does not duplicate rows', (await countProducts()) === 3, `count=${await countProducts()}`);

    const updated = await req('POST', '/products/import', {
        rows: [{ name: 'Imported Rice 5kg', sku: `IMP-RICE-${RUN}`, category: 'Groceries', price: '135', stock: '40' }],
        updateExisting: true,
    }, admin);
    check('updateExisting refreshes instead of skipping', updated.data?.updated === 1, `updated=${updated.data?.updated}`);
    const riceAfter = await db.query('SELECT price, stock FROM products WHERE store_id = $1 AND sku = $2', [STORE_ID, `IMP-RICE-${RUN}`]);
    check('the update actually changed the values',
        Number(riceAfter.rows[0].price) === 135 && Number(riceAfter.rows[0].stock) === 40,
        `price=${riceAfter.rows[0].price} stock=${riceAfter.rows[0].stock}`);

    const dupeInFile = await req('POST', '/products/import', {
        rows: [
            { name: 'Twice In File', sku: `IMP-TWICE-${RUN}`, price: '10' },
            { name: 'Twice In File', sku: `IMP-TWICE-${RUN}`, price: '12' },
        ],
    }, admin);
    check('a product listed twice in one file imports once',
        dupeInFile.data?.created === 1 && dupeInFile.data?.skipped === 1,
        `created=${dupeInFile.data?.created} skipped=${dupeInFile.data?.skipped}`);

    // 6 + 7. Guards.
    const empty = await req('POST', '/products/import', { rows: [] }, admin);
    check('an empty file is rejected with a useful message', empty.status === 400, empty.data?.message);

    const huge = await req('POST', '/products/import', {
        rows: Array.from({ length: 2001 }, (_, i) => ({ name: `Bulk ${i}`, price: '1' })),
    }, admin);
    check('an oversized file is refused', huge.status === 400, huge.data?.message);

    const staffAttempt = await req('POST', '/products/import', { rows: goodRows }, staff);
    check('staff without inventory rights cannot import', staffAttempt.status === 403, `status ${staffAttempt.status}`);

    const noAuth = await req('POST', '/products/import', { rows: goodRows });
    check('an unauthenticated import is refused', noAuth.status === 401, `status ${noAuth.status}`);

    // The freemium cap: drop the unlimited add-on and try to exceed the limit.
    await db.query(`UPDATE store_settings SET enabled_modules = '{}' WHERE store_id = $1`, [STORE_ID]);
    const capped = await req('POST', '/products/import', {
        rows: Array.from({ length: 60 }, (_, i) => ({ name: `Capped ${RUN} ${i}`, price: '5' })),
    }, admin);
    check('the free product cap applies to the whole batch', capped.status === 402, `status ${capped.status}`);
    check('nothing was imported when the cap blocked it', (await countProducts()) === 4, `count=${await countProducts()}`);
};

run()
    .catch(e => {
        console.error(e);
        check('suite ran to completion', false, e.message);
    })
    .finally(async () => {
        await cleanup().catch(() => {});
        await db.end().catch(() => {});
        const failed = results.filter(r => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length ? 1 : 0);
    });
