/**
 * The paid-only packaging, end to end.
 *
 * SalePilot used to be free core plus à-la-carte add-ons. It is now a paid
 * product: a 7-day trial, then you pay. All three tiers include every feature
 * and differ on capacity instead (shops, staff logins, products, AI).
 *
 * Two things here are worth more than the rest. First, that a lapsed shop is
 * actually locked out — the old model deliberately let `past_due` through,
 * because core POS was free, and that must no longer be true. Second, that the
 * lock does NOT close the door it has to leave open: a store with no access
 * must still reach billing, or it can never pay its way back in.
 *
 * Self-contained: seeds throwaway stores and users, and removes them after.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/paid-only-plans.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `paidonly-${Date.now()}`;
const PASSWORD = 'paidonly-password-1';

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
const storeIds = [];
const userIds = [];

/** A store on a given plan, whose subscription ends `endsInDays` from now. */
const seedStore = async (tag, { plan = 'plan_basic', status = 'active', endsInDays = 30 } = {}) => {
    const storeId = `store-${tag}-${RUN}`;
    const userId = `user-${tag}-${RUN}`;
    const email = `${tag}-${RUN}@test.local`;
    storeIds.push(storeId);
    userIds.push(userId);
    const endsAt = new Date(Date.now() + endsInDays * 86400000);
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status, subscription_plan, subscription_ends_at, owner_id)
         VALUES ($1, $2, 'active', $3, $4, $5, $6)`,
        [storeId, `Paid Only ${tag} ${RUN}`, status, plan, endsAt, userId],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, $2, $3, $4, 'admin', $5, true)`,
        [userId, `Owner ${tag}`, email, bcrypt.hashSync(PASSWORD, 10), storeId],
    );
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled, enabled_modules)
         VALUES ($1, $2, 16, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true, $3)`,
        [storeId, `Paid Only ${tag}`, []],
    );
    const login = await req('POST', '/auth/login', { email, password: PASSWORD });
    return { storeId, userId, email, token: login.data?.token, login };
};

const cleanup = async () => {
    for (const storeId of storeIds) {
        for (const t of ['products', 'suppliers', 'accounts', 'audit_logs', 'store_settings']) {
            await db.query(`DELETE FROM ${t} WHERE store_id = $1`, [storeId]).catch(() => {});
        }
    }
    for (const userId of userIds) {
        await db.query('DELETE FROM users WHERE current_store_id = ANY($1::text[]) OR id = $2', [storeIds, userId]).catch(() => {});
    }
    for (const storeId of storeIds) {
        await db.query('DELETE FROM stores WHERE id = $1', [storeId]).catch(() => {});
    }
};

const main = async () => {
    await db.connect();

    // ------------------------------------------------- a paying store -------
    const paid = await seedStore('paid', { plan: 'plan_basic', status: 'active', endsInDays: 30 });
    if (!paid.token) {
        console.error('FATAL: login failed', paid.login.status, JSON.stringify(paid.login.data).slice(0, 300));
        process.exit(1);
    }
    const PAID = { Authorization: `Bearer ${paid.token}` };

    check('a paying store can trade', (await req('GET', '/products', null, PAID)).status === 200);

    // Every feature is included on every tier, so what used to be the priciest
    // add-ons must answer on the cheapest plan.
    const today = new Date().toISOString().slice(0, 10);
    const range = `startDate=${today}&endDate=${today}`;
    check('Basic includes the advanced reports',
        (await req('GET', `/reports/product-sales?${range}`, null, PAID)).status === 200);
    check('Basic includes auto-reorder suggestions',
        (await req('GET', '/purchase-orders/reorder-suggestions', null, PAID)).status === 200);

    // ------------------------------------------------ inside the grace ------
    // Expired yesterday: still trading, because a payment may be in flight.
    const grace = await seedStore('grace', { status: 'active', endsInDays: -1 });
    const GRACE = { Authorization: `Bearer ${grace.token}` };
    check('a store one day past expiry still trades (grace)',
        (await req('GET', '/products', null, GRACE)).status === 200);

    // Even when the nightly job has already written past_due, grace still holds.
    await db.query(`UPDATE stores SET subscription_status = 'past_due' WHERE id = $1`, [grace.storeId]);
    check('grace holds even if the job marked it past_due early',
        (await req('GET', '/products', null, GRACE)).status === 200);

    // ------------------------------------------------- past the grace -------
    const lapsed = await seedStore('lapsed', { status: 'trial', endsInDays: -10 });
    const LAPSED = { Authorization: `Bearer ${lapsed.token}` };

    const blocked = await req('GET', '/products', null, LAPSED);
    check('a lapsed store cannot trade', blocked.status === 402, `status=${blocked.status}`);
    check('the refusal says a subscription is required', blocked.data?.code === 'SUBSCRIPTION_REQUIRED',
        JSON.stringify(blocked.data).slice(0, 140));
    const blockedSale = await req('POST', '/sales', {
        cart: [], subtotal: 0, discount: 0, tax: 0, total: 0,
        paymentStatus: 'paid', amountPaid: 0, storeCreditUsed: 0, payments: [],
    }, LAPSED);
    check('a lapsed store cannot ring up a sale', blockedSale.status === 402, `status=${blockedSale.status}`);

    // This is the part that must not break: paying your way back in.
    check('a lapsed store can still read the plans',
        (await req('GET', '/subscriptions/plans', null, LAPSED)).status === 200);
    const lapsedNotif = await req('GET', '/notifications/mine', null, LAPSED);
    check('a lapsed store can still see notifications', lapsedNotif.status === 200, `status=${lapsedNotif.status}`);
    const lapsedMe = await req('GET', '/auth/me', null, LAPSED);
    check('a lapsed store can still load its own session', lapsedMe.status === 200, `status=${lapsedMe.status}`);
    check('a lapsed store can still switch business', (await req('GET', '/stores/mine', null, LAPSED)).status === 200);

    // Nothing is free behind the trial, so even reads are refused.
    check('a lapsed store cannot read its reports',
        (await req('GET', `/reports/dashboard?${range}`, null, LAPSED)).status === 402);

    // ------------------------------------------------ capacity ceilings -----
    // Seats: Basic is owner + 1 cashier. The owner already holds a seat, so one
    // more must be allowed and the one after that refused.
    const secondSeat = await req('POST', '/users', {
        name: 'Cashier One', email: `cashier1-${RUN}@test.local`, password: 'cashier-pass-1', role: 'staff',
    }, PAID);
    check('Basic includes the cashier (second seat)', secondSeat.status === 201 || secondSeat.status === 200,
        `status=${secondSeat.status}`);

    const thirdSeat = await req('POST', '/users', {
        name: 'Cashier Two', email: `cashier2-${RUN}@test.local`, password: 'cashier-pass-2', role: 'staff',
    }, PAID);
    check('a third seat is refused on Basic', thirdSeat.status === 402, `status=${thirdSeat.status}`);
    check('the refusal is a plan ceiling, not a locked feature', thirdSeat.data?.code === 'PLAN_LIMIT',
        JSON.stringify(thirdSeat.data).slice(0, 140));
    check('it names which ceiling was hit', thirdSeat.data?.limit === 'seats', JSON.stringify(thirdSeat.data?.limit));

    // A larger tier raises the same ceiling rather than unlocking a feature.
    await db.query(`UPDATE stores SET subscription_plan = 'plan_pro' WHERE id = $1`, [paid.storeId]);
    const seatOnPro = await req('POST', '/users', {
        name: 'Cashier Three', email: `cashier3-${RUN}@test.local`, password: 'cashier-pass-3', role: 'staff',
    }, PAID);
    check('Pro raises the seat ceiling', seatOnPro.status === 201 || seatOnPro.status === 200, `status=${seatOnPro.status}`);

    // ----------------------------------------------- the trial length -------
    // A brand-new shop gets 7 days and nothing else: there is no free tier for
    // it to fall back to, which is the whole point of the change.
    const newOwnerId = `user-newowner-${RUN}`;
    const newOwnerEmail = `newowner-${RUN}@test.local`;
    userIds.push(newOwnerId);
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, is_verified)
         VALUES ($1, 'New Owner', $2, $3, 'admin', true)`,
        [newOwnerId, newOwnerEmail, bcrypt.hashSync(PASSWORD, 10)],
    );
    const newLogin = await req('POST', '/auth/login', { email: newOwnerEmail, password: PASSWORD });
    const NEW = { Authorization: `Bearer ${newLogin.data?.token}` };
    const newStoreName = `Trial Length Shop ${RUN}`;
    const registered = await req('POST', '/stores/register', { name: newStoreName, planId: 'plan_basic' }, NEW);
    check('a new shop can register', registered.status === 201 || registered.status === 200, `status=${registered.status}`);

    const trialRow = await db.query(
        `SELECT id, subscription_status, subscription_ends_at FROM stores WHERE LOWER(trim(name)) = LOWER($1)`,
        [newStoreName],
    );
    if (trialRow.rowCount > 0) storeIds.push(trialRow.rows[0].id);
    check('it starts on trial, not active', trialRow.rows[0]?.subscription_status === 'trial',
        trialRow.rows[0]?.subscription_status);
    const trialDays = trialRow.rows[0]?.subscription_ends_at
        ? Math.round((new Date(trialRow.rows[0].subscription_ends_at).getTime() - Date.now()) / 86400000)
        : null;
    check('the trial is 7 days', trialDays === 7, `days=${trialDays}`);

    // A second shop is refused on Basic — shops are a capacity too.
    const secondShop = await req('POST', '/stores/register', { name: `Second Shop ${RUN}`, planId: 'plan_basic' }, NEW);
    check('a second shop is refused on Basic', secondShop.status === 402, `status=${secondShop.status}`);
    check('the second-shop refusal names the stores ceiling', secondShop.data?.limit === 'stores',
        JSON.stringify(secondShop.data).slice(0, 140));

    // ------------------------------------------------- the catalogue --------
    const plansRes = await req('GET', '/subscriptions/plans', null, PAID);
    const plans = Array.isArray(plansRes.data) ? plansRes.data : (plansRes.data?.plans || []);
    check('all three tiers are on sale', plans.filter(p => p.active !== false).length >= 3, `count=${plans.length}`);

    // The public payload does not carry module ids, so this is read from the
    // catalogue itself: every tier must grant the whole set.
    const planRows = await db.query('SELECT id, module_ids FROM catalog_plans ORDER BY id');
    const grants = planRows.rows.map(r => `${r.id}:${(r.module_ids || []).length}`);
    check('every tier grants every feature',
        planRows.rowCount > 0 && planRows.rows.every(r => (r.module_ids || []).length >= 10), grants.join(' '));

    const addonsRes = await req('GET', '/subscriptions/addons', null, PAID);
    const addons = Array.isArray(addonsRes.data) ? addonsRes.data : (addonsRes.data?.modules || addonsRes.data?.addons || []);
    check('nothing is sold à la carte any more', addons.length === 0, `addons=${addons.map(a => a.id).join(',') || 'none'}`);

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
