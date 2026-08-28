/**
 * Erasing a store, end to end.
 *
 * Two things have to be true and only a real database can show either: that
 * everything belonging to the store is gone, and that nothing belonging to
 * anyone else moved. The second is the one that matters — a deletion that
 * reaches into a neighbouring store is unrecoverable and would be discovered
 * by its owner, not by us.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/store-deletion.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `deltest-${Date.now()}`;
const DOOMED = `store-doomed-${RUN}`;
const SPARED = `store-spared-${RUN}`;
const OWNER = `owner-${RUN}`;
const STAFF = `staff-${RUN}`;
const MULTI = `multi-${RUN}`;
const SUPER_EMAIL = process.env.SUPERADMIN_EMAIL || 'superadmin@sale-pilot.com';
const SUPER_PASSWORD = process.env.SUPERADMIN_PASSWORD || 'password_super';
const PASSWORD = 'deltest-password-1';

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

const seedStore = async (storeId, label, ownerId) => {
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status, owner_id)
         VALUES ($1, $2, 'active', 'active', $3)`,
        [storeId, label, ownerId],
    );
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled)
         VALUES ($1, $2, 16, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true)`,
        [storeId, label],
    );
    const productId = `prod-${storeId}`;
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls)
         VALUES ($1, 'Widget', $2, 100, 60, 50, 'active', $3, '{}')`,
        [productId, `SKU-${storeId}`, storeId],
    );
    const customerId = `cust-${storeId}`;
    await db.query(
        `INSERT INTO customers (id, name, store_id) VALUES ($1, 'A Customer', $2)`,
        [customerId, storeId],
    );
    return { productId, customerId };
};

const countIn = async (storeId) => {
    const { rows } = await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE column_name = 'store_id' AND table_schema = 'public'`,
    );
    let total = 0;
    for (const r of rows) {
        const c = await db.query(`SELECT COUNT(*)::int AS n FROM "${r.table_name}" WHERE store_id = $1`, [storeId]);
        total += Number(c.rows[0].n) || 0;
    }
    return total;
};

const cleanup = async () => {
    const { rows } = await db.query(
        `SELECT table_name FROM information_schema.columns
          WHERE column_name = 'store_id' AND table_schema = 'public'`,
    );
    for (const s of [DOOMED, SPARED]) {
        for (const r of rows) {
            await db.query(`DELETE FROM "${r.table_name}" WHERE store_id = $1`, [s]).catch(() => {});
        }
    }
    await db.query('DELETE FROM users WHERE id = ANY($1::text[])', [[OWNER, STAFF, MULTI]]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = ANY($1::text[])', [[DOOMED, SPARED]]).catch(() => {});
};

const main = async () => {
    await db.connect();
    await cleanup();

    const hash = bcrypt.hashSync(PASSWORD, 10);
    // Owner of the doomed store and nothing else: the account goes with it.
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Doomed Owner', $2, $3, 'admin', $4, true)`,
        [OWNER, `${OWNER}@test.local`, hash, DOOMED],
    );
    // Staff at the doomed store: same.
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Doomed Staff', $2, $3, 'staff', $4, true)`,
        [STAFF, `${STAFF}@test.local`, hash, DOOMED],
    );
    // Owns both: keeps their login and is moved to the survivor.
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Multi Owner', $2, $3, 'admin', $4, true)`,
        [MULTI, `${MULTI}@test.local`, hash, DOOMED],
    );

    await seedStore(DOOMED, `Doomed Store ${RUN}`, OWNER);
    await seedStore(SPARED, `Spared Store ${RUN}`, MULTI);
    await db.query('UPDATE stores SET owner_id = $1 WHERE id = $2', [MULTI, SPARED]);

    const login = await req('POST', '/auth/login', { email: SUPER_EMAIL, password: SUPER_PASSWORD });
    if (!login.data?.token) {
        console.error('FATAL: superadmin login failed. Set SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD.',
            login.status, JSON.stringify(login.data).slice(0, 200));
        process.exit(1);
    }
    const SU = { Authorization: `Bearer ${login.data.token}` };

    // Trade in both stores before deleting one. Three rows would never
    // exercise the ordering: sales, sale_items, payments and the journal
    // entries behind them are a real foreign-key chain, and deleting a parent
    // before its children is exactly how this goes wrong.
    const ring = async (storeId, email) => {
        const r = await req('POST', '/auth/login', { email, password: PASSWORD });
        if (!r.data?.token) return;
        const H = { Authorization: `Bearer ${r.data.token}` };
        await req('POST', '/sales', {
            cart: [{ productId: `prod-${storeId}`, name: 'Widget', price: 100, quantity: 2 }],
            subtotal: 200, discount: 0, tax: 32, total: 232,
            paymentStatus: 'paid', amountPaid: 232, storeCreditUsed: 0,
            payments: [{ amount: 232, method: 'Cash' }],
        }, H);
    };
    await ring(DOOMED, `${OWNER}@test.local`);
    // The neighbour needs real trade of its own, or "untouched" only ever
    // proves three stub rows survived. Sales land in the seller's active
    // store, so this owner is moved there and back.
    await db.query('UPDATE users SET current_store_id = $1 WHERE id = $2', [SPARED, MULTI]);
    await ring(SPARED, `${MULTI}@test.local`);
    await db.query('UPDATE users SET current_store_id = $1 WHERE id = $2', [DOOMED, MULTI]);

    const doomedBefore = await countIn(DOOMED);
    const sparedBefore = await countIn(SPARED);
    check('the doomed store has real trade behind it, not just a stub row',
        doomedBefore > 10, `rows=${doomedBefore}`);
    check('so does the neighbour, so "untouched" means something',
        sparedBefore > 10, `rows=${sparedBefore}`);

    // ---- preview ----
    const preview = await req('GET', `/superadmin/stores/${DOOMED}/deletion-preview`, null, SU);
    check('preview describes what would go', preview.status === 200 && preview.data?.totalRows > 0,
        `status=${preview.status} rows=${preview.data?.totalRows}`);
    check('preview names the accounts that would be left without a store',
        (preview.data?.usersOrphaned || []).length === 2,
        JSON.stringify((preview.data?.usersOrphaned || []).map(u => u.name)));
    check('preview names the account that would simply move',
        (preview.data?.usersRepointed || []).length === 1,
        JSON.stringify((preview.data?.usersRepointed || []).map(u => u.name)));
    check('preview destroys nothing', (await countIn(DOOMED)) === doomedBefore,
        `rows ${doomedBefore} -> ${await countIn(DOOMED)}`);

    // ---- the confirmation rail ----
    const noName = await req('DELETE', `/superadmin/stores/${DOOMED}`, {}, SU);
    check('deleting without typing the name is refused', noName.status === 400, `status=${noName.status}`);

    const wrongName = await req('DELETE', `/superadmin/stores/${DOOMED}`, { confirmName: 'Something Else' }, SU);
    check('a mistyped name is refused', wrongName.status === 400, `status=${wrongName.status}`);
    check('nothing was deleted by the refused attempts', (await countIn(DOOMED)) === doomedBefore,
        `rows=${await countIn(DOOMED)}`);

    // ---- only a superadmin ----
    const adminLogin = await req('POST', '/auth/login', { email: `${MULTI}@test.local`, password: PASSWORD });
    if (adminLogin.data?.token) {
        const asAdmin = await req('DELETE', `/superadmin/stores/${DOOMED}`,
            { confirmName: `Doomed Store ${RUN}` },
            { Authorization: `Bearer ${adminLogin.data.token}` });
        check('a store admin cannot delete a store', asAdmin.status === 403 || asAdmin.status === 401,
            `status=${asAdmin.status}`);
    }

    // ---- the deletion itself ----
    const done = await req('DELETE', `/superadmin/stores/${DOOMED}`,
        { confirmName: `Doomed Store ${RUN}` }, SU);
    check('the store is deleted', done.status === 200, `status=${done.status}`);
    check('the result says what was destroyed',
        done.data?.totalRows > 0 && Array.isArray(done.data?.tables),
        `rows=${done.data?.totalRows} tables=${(done.data?.tables || []).length}`);
    check('it reached across the whole foreign-key chain, not just the loose rows',
        (done.data?.tables || []).some(t => t.table === 'sale_items')
        && (done.data?.tables || []).some(t => t.table === 'sales')
        && (done.data?.tables || []).some(t => t.table === 'journal_entry_lines'),
        (done.data?.tables || []).map(t => t.table).join(', '));

    check('every row belonging to the store is gone', (await countIn(DOOMED)) === 0,
        `remaining=${await countIn(DOOMED)}`);

    const store = await db.query('SELECT id FROM stores WHERE id = $1', [DOOMED]);
    check('the store row itself is gone', store.rowCount === 0);

    // ---- and nothing else moved ----
    check('the other store is untouched', (await countIn(SPARED)) === sparedBefore,
        `rows ${sparedBefore} -> ${await countIn(SPARED)}`);
    const spared = await db.query('SELECT id FROM stores WHERE id = $1', [SPARED]);
    check('the other store still exists', spared.rowCount === 1);

    // ---- accounts ----
    const kept = await db.query(
        'SELECT id, current_store_id FROM users WHERE id = ANY($1::text[])', [[OWNER, STAFF]]);
    check('accounts are kept, not destroyed with the store', kept.rowCount === 2,
        `remaining=${kept.rowCount}`);
    check('and are left with no store rather than pointing at a deleted one',
        kept.rows.every(r => r.current_store_id === null),
        kept.rows.map(r => String(r.current_store_id)).join(', '));

    const moved = await db.query('SELECT current_store_id FROM users WHERE id = $1', [MULTI]);
    check('an owner of another store keeps their login',
        moved.rowCount === 1, `rows=${moved.rowCount}`);
    check('and is moved to the store they still have',
        moved.rows[0]?.current_store_id === SPARED,
        `current_store_id=${moved.rows[0]?.current_store_id}`);

    // ---- it is written down ----
    const trail = await db.query(
        `SELECT details FROM audit_logs WHERE action = 'Store Deleted' AND details LIKE $1`,
        [`%${DOOMED}%`],
    );
    check('the deletion is recorded, since nothing else survives to describe it',
        trail.rowCount === 1, `rows=${trail.rowCount}`);

    // ---- deleting it again ----
    const again = await req('DELETE', `/superadmin/stores/${DOOMED}`,
        { confirmName: `Doomed Store ${RUN}` }, SU);
    check('a store that is already gone reports not found', again.status === 404,
        `status=${again.status}`);
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
