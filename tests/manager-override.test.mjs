/**
 * Manager overrides, end to end.
 *
 * The rule about when one is needed is unit-tested in override-rules. This
 * covers what that cannot: that a cashier is actually stopped, that a PIN
 * actually admits a manager, and above all that one approval cannot be spent
 * twice — the whole control rests on that.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/manager-override.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `ovrtest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const BOSS_ID = `boss-${RUN}`;
const TILL_ID = `till-${RUN}`;
const PRODUCT_ID = `prod-${RUN}`;
const BOSS_EMAIL = `boss-${RUN}@test.local`;
const TILL_EMAIL = `till-${RUN}@test.local`;
const PASSWORD = 'ovrtest-password-1';
const PIN = '481902';

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
        [STORE_ID, `Override Test Store ${RUN}`],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'The Boss', $2, $3, 'admin', $4, true)`,
        [BOSS_ID, BOSS_EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Till Operator', $2, $3, 'staff', $4, true)`,
        [TILL_ID, TILL_EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled)
         VALUES ($1, 'Override Test Store', 0, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true)`,
        [STORE_ID],
    );
    await db.query(
        `INSERT INTO products (id, name, sku, price, cost_price, stock, status, store_id, image_urls)
         VALUES ($1, 'Test Widget', $2, 100.00, 60.00, 1000, 'active', $3, '{}')`,
        [PRODUCT_ID, `OVR-${RUN}`, STORE_ID],
    );
};

const cleanup = async () => {
    const tables = [
        'journal_entry_lines', 'journal_entries', 'return_items', 'returns',
        'payments', 'sale_items', 'sales', 'cash_movements', 'cash_sessions',
        'override_authorizations', 'accounts', 'products', 'audit_logs', 'store_settings',
    ];
    for (const t of tables) {
        await db.query(`DELETE FROM ${t} WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    }
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[BOSS_ID, TILL_ID]]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = $1', [STORE_ID]).catch(() => {});
};

/** A sale of one widget with the given cash discount. */
const sale = (discount, overrideId) => ({
    cart: [{ productId: PRODUCT_ID, name: 'Test Widget', price: 100, quantity: 1 }],
    subtotal: 100, discount, tax: 0, total: 100 - discount,
    paymentStatus: 'paid', amountPaid: 100 - discount, storeCreditUsed: 0,
    payments: [{ amount: 100 - discount, method: 'Cash' }],
    ...(overrideId ? { overrideId } : {}),
});

const main = async () => {
    await db.connect();
    await seed();

    const loginAs = async (email) => {
        const r = await req('POST', '/auth/login', { email, password: PASSWORD });
        if (!r.data?.token) {
            console.error('FATAL: login failed for', email, r.status, JSON.stringify(r.data).slice(0, 200));
            process.exit(1);
        }
        return { Authorization: `Bearer ${r.data.token}` };
    };
    const BOSS = await loginAs(BOSS_EMAIL);
    const TILL = await loginAs(TILL_EMAIL);

    // ---- a store with no limits set behaves exactly as it always did ----
    const before = await req('POST', '/sales', sale(90), TILL);
    check('with no limits set, a big discount still goes through',
        before.status === 201, `status=${before.status}`);

    // ---- set a limit ----
    await req('PUT', '/settings', {
        name: 'Override Test Store', taxRate: 0, lowStockThreshold: 5, enableStoreCredit: true,
        currency: { symbol: 'K', code: 'ZMW', position: 'before' },
        overrideThresholds: { discountPercent: 10, refundAmount: 500, payOutAmount: 200, noSale: true },
    }, BOSS);
    const settings = await req('GET', '/overrides', null, TILL);
    check('the till can see what needs approving',
        Number(settings.data?.discountPercent) === 10, JSON.stringify(settings.data));

    // ---- the cashier is stopped ----
    const small = await req('POST', '/sales', sale(5), TILL);
    check('a discount under the limit needs nobody', small.status === 201, `status=${small.status}`);

    const blocked = await req('POST', '/sales', sale(20), TILL);
    check('a discount over the limit is refused', blocked.status === 403, `status=${blocked.status}`);
    check('the refusal says what needs approving',
        blocked.data?.requiresOverride === 'discount', JSON.stringify(blocked.data));

    const bossSale = await req('POST', '/sales', sale(50), BOSS);
    check('a manager at the till approves nothing, they simply act',
        bossSale.status === 201, `status=${bossSale.status}`);

    // ---- PINs ----
    const shortPin = await req('PUT', '/overrides/pin', { password: PASSWORD, pin: '1234' }, BOSS);
    check('a PIN short enough to guess is refused', shortPin.status === 400, `status=${shortPin.status}`);

    const runPin = await req('PUT', '/overrides/pin', { password: PASSWORD, pin: '111111' }, BOSS);
    check('an obvious PIN is refused', runPin.status === 400, `status=${runPin.status}`);

    const wrongPassword = await req('PUT', '/overrides/pin', { password: 'not-it', pin: PIN }, BOSS);
    check('setting a PIN confirms the account password',
        wrongPassword.status === 403, `status=${wrongPassword.status}`);

    const staffPin = await req('PUT', '/overrides/pin', { password: PASSWORD, pin: PIN }, TILL);
    check('a cashier cannot give themselves an approval PIN',
        staffPin.status === 403, `status=${staffPin.status}`);

    const setPin = await req('PUT', '/overrides/pin', { password: PASSWORD, pin: PIN }, BOSS);
    check('a manager can set a PIN', setPin.status === 200 && setPin.data?.hasPin === true,
        `status=${setPin.status} ${JSON.stringify(setPin.data)}`);

    // ---- approving ----
    const wrongPin = await req('POST', '/overrides',
        { action: 'discount', amount: 20, pin: '999999' }, TILL);
    check('a wrong PIN approves nothing', wrongPin.status === 403, `status=${wrongPin.status}`);

    const granted = await req('POST', '/overrides',
        { action: 'discount', amount: 20, pin: PIN, reason: 'Damaged box' }, TILL);
    check('the right PIN grants an approval', granted.status === 201 && !!granted.data?.id,
        `status=${granted.status}`);
    check('the approval names the manager who gave it',
        granted.data?.authorizedBy === 'The Boss', JSON.stringify(granted.data));

    const withOverride = await req('POST', '/sales', sale(20, granted.data?.id), TILL);
    check('the discount goes through with the approval',
        withOverride.status === 201, `status=${withOverride.status}`);

    // ---- the part the whole control rests on ----
    const replay = await req('POST', '/sales', sale(20, granted.data?.id), TILL);
    check('the same approval cannot be spent twice', replay.status === 403, `status=${replay.status}`);

    const smallGrant = await req('POST', '/overrides',
        { action: 'discount', amount: 15, pin: PIN }, TILL);
    const overspend = await req('POST', '/sales', sale(60, smallGrant.data?.id), TILL);
    check('an approval for a smaller discount does not cover a larger one',
        overspend.status === 403, `status=${overspend.status}`);

    const wrongAction = await req('POST', '/overrides',
        { action: 'refund', amount: 100, pin: PIN }, TILL);
    const misuse = await req('POST', '/sales', sale(20, wrongAction.data?.id), TILL);
    check('an approval for a refund does not authorise a discount',
        misuse.status === 403, `status=${misuse.status}`);

    // ---- the other two gates ----
    const openTill = await req('POST', '/cash-sessions', { openingFloat: 1000 }, TILL);
    const bigPayOut = await req('POST', `/cash-sessions/${openTill.data?.id}/movements`,
        { type: 'pay_out', amount: 300, reason: 'Supplier' }, TILL);
    check('a large pay-out is refused without approval',
        bigPayOut.status === 403, `status=${bigPayOut.status}`);

    const smallPayOut = await req('POST', `/cash-sessions/${openTill.data?.id}/movements`,
        { type: 'pay_out', amount: 50, reason: 'Driver' }, TILL);
    check('a small pay-out needs nobody', smallPayOut.status === 201, `status=${smallPayOut.status}`);

    const bigPayIn = await req('POST', `/cash-sessions/${openTill.data?.id}/movements`,
        { type: 'pay_in', amount: 5000, reason: 'Float' }, TILL);
    check('paying money in never needs approval, whatever the size',
        bigPayIn.status === 201, `status=${bigPayIn.status}`);

    const payOutGrant = await req('POST', '/overrides',
        { action: 'pay_out', amount: 300, pin: PIN }, TILL);
    const allowedPayOut = await req('POST', `/cash-sessions/${openTill.data?.id}/movements`,
        { type: 'pay_out', amount: 300, reason: 'Supplier', overrideId: payOutGrant.data?.id }, TILL);
    check('an approved pay-out goes through', allowedPayOut.status === 201,
        `status=${allowedPayOut.status}`);

    // ---- opening the drawer with no sale ----
    const bareDrawer = await req('POST', `/cash-sessions/${openTill.data?.id}/no-sale`,
        { reason: 'Customer wanted change' }, TILL);
    check('opening the drawer with no sale is refused without approval',
        bareDrawer.status === 403, `status=${bareDrawer.status}`);

    const drawerGrant = await req('POST', '/overrides', { action: 'no_sale', pin: PIN }, TILL);
    const allowedDrawer = await req('POST', `/cash-sessions/${openTill.data?.id}/no-sale`,
        { reason: 'Customer wanted change', overrideId: drawerGrant.data?.id }, TILL);
    check('an approved drawer opening is allowed', allowedDrawer.status === 201,
        `status=${allowedDrawer.status}`);

    // The whole point: it leaves a mark that a Z report can count.
    const opens = await db.query(
        `SELECT COUNT(*)::int AS n FROM cash_movements
          WHERE session_id = $1 AND type = 'no_sale'`,
        [openTill.data?.id],
    );
    check('the drawer opening is recorded against the till',
        opens.rows[0]?.n === 1, `count=${opens.rows[0]?.n}`);

    const report = await req('GET', `/cash-sessions/${openTill.data?.id}/report`, null, BOSS);
    check('the report counts drawer openings separately from cash',
        report.data?.noSaleOpens === 1
        && Math.abs(Number(report.data?.expectedCash) - (1000 - 50 - 300 + 5000)) < 0.011,
        `noSaleOpens=${report.data?.noSaleOpens} expected=${report.data?.expectedCash}`);

    // ---- it is all written down ----
    const trail = await db.query(
        `SELECT action FROM audit_logs
          WHERE store_id = $1 AND (action LIKE 'Override%' OR action LIKE '%Override Used')`,
        [STORE_ID],
    );
    check('approvals and refusals are recorded', trail.rows.length >= 3,
        trail.rows.map(r => r.action).join(', '));
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
