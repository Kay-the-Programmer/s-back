/**
 * Session revocation, end to end.
 *
 * Access tokens are self-contained and live for 30 days, so the only thing
 * that can take one back is the token_version it carries. These checks are
 * about the moments where that has to happen: a password change, a demotion,
 * a deletion, and an explicit sign-out-everywhere.
 *
 * Two of them are really about the auth cache rather than the token. `protect`
 * caches the user row for AUTH_USER_CACHE_TTL_MS (60s by default), and that
 * row holds `role`, so a demotion or deletion that only touched the database
 * left the old privileges answering requests until the TTL ran out. Those two
 * checks fail if the eviction is ever dropped — they are the regression guard,
 * and they only mean something while the cache is enabled, so run this with
 * the default TTL rather than AUTH_USER_CACHE_TTL_MS=0.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/session-revocation.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `revtest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const BOSS_ID = `boss-${RUN}`;
const STAFF_ID = `staff-${RUN}`;
const DOOMED_ID = `doomed-${RUN}`;
const BOSS_EMAIL = `boss-${RUN}@test.local`;
const STAFF_EMAIL = `staff-${RUN}@test.local`;
const DOOMED_EMAIL = `doomed-${RUN}@test.local`;
const PASSWORD = 'revtest-password-1';
const NEW_PASSWORD = 'revtest-password-2';

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

const bearer = (token) => ({ Authorization: `Bearer ${token}` });

const db = new pg.Client({ connectionString: DATABASE_URL });

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`,
        [STORE_ID, `Revocation Test Store ${RUN}`],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'The Boss', $2, $3, 'admin', $4, true)`,
        [BOSS_ID, BOSS_EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Inventory Person', $2, $3, 'inventory_manager', $4, true)`,
        [STAFF_ID, STAFF_EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Doomed Account', $2, $3, 'staff', $4, true)`,
        [DOOMED_ID, DOOMED_EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled)
         VALUES ($1, 'Revocation Test Store', 0, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true)`,
        [STORE_ID],
    );
};

const cleanup = async () => {
    await db.query(`DELETE FROM store_settings WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    await db.query(`DELETE FROM audit_logs WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    await db.query(`DELETE FROM users WHERE current_store_id = $1`, [STORE_ID]).catch(() => {});
    await db.query(`DELETE FROM stores WHERE id = $1`, [STORE_ID]).catch(() => {});
};

const login = async (email, password = PASSWORD) => {
    const r = await req('POST', '/auth/login', { email, password });
    return r.data?.token;
};

const main = async () => {
    await db.connect();
    await cleanup();
    await seed();

    // ---- a token keeps working until something revokes it ----
    const bossToken = await login(BOSS_EMAIL);
    check('a fresh token is accepted', !!bossToken && (await req('GET', '/auth/me', null, bearer(bossToken))).status === 200);

    // The claim has to actually be in the token, or nothing below is being
    // tested — a token with no tv reads as 0 and would pass by default.
    const claims = bossToken ? JSON.parse(Buffer.from(bossToken.split('.')[1], 'base64url').toString()) : {};
    check('the token carries a token_version claim', typeof claims.tv === 'number', `tv=${claims.tv}`);

    // ---- sign out everywhere ----
    const secondDevice = await login(BOSS_EMAIL);
    const signOut = await req('POST', '/auth/sign-out-everywhere', null, bearer(bossToken));
    check('sign-out-everywhere succeeds', signOut.status === 200, `status=${signOut.status}`);

    const afterSignOut = await req('GET', '/auth/me', null, bearer(bossToken));
    check('the token that asked is now rejected',
        afterSignOut.status === 401 && afterSignOut.data?.code === 'SESSION_REVOKED',
        `status=${afterSignOut.status} code=${afterSignOut.data?.code}`);

    const otherDevice = await req('GET', '/auth/me', null, bearer(secondDevice));
    check('a token from another device is rejected too',
        otherDevice.status === 401 && otherDevice.data?.code === 'SESSION_REVOKED',
        `status=${otherDevice.status} code=${otherDevice.data?.code}`);

    const freshAfterSignOut = await login(BOSS_EMAIL);
    check('signing in again works',
        !!freshAfterSignOut && (await req('GET', '/auth/me', null, bearer(freshAfterSignOut))).status === 200);

    // ---- changing a password ----
    const staleStaffToken = await login(STAFF_EMAIL);
    const changed = await req('POST', '/auth/change-password',
        { currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, bearer(staleStaffToken));
    check('changing a password succeeds', changed.status === 200, `status=${changed.status}`);

    check('the password change reissues a token for the caller',
        !!changed.data?.token && (await req('GET', '/auth/me', null, bearer(changed.data.token))).status === 200);

    const afterChange = await req('GET', '/auth/me', null, bearer(staleStaffToken));
    check('the token held before the change is rejected',
        afterChange.status === 401 && afterChange.data?.code === 'SESSION_REVOKED',
        `status=${afterChange.status} code=${afterChange.data?.code}`);

    // ---- a demotion reaches a live session ----
    // This is the cache regression guard: the demoted user's row is sitting in
    // the auth cache with inventory_manager on it, so without eviction the old
    // role answers for up to a minute.
    const inventoryToken = changed.data?.token;
    const beforeDemotion = await req('GET', '/products', null, bearer(inventoryToken));
    check('an inventory manager can read inventory before demotion',
        beforeDemotion.status === 200, `status=${beforeDemotion.status}`);

    const boss = bearer(freshAfterSignOut);
    const demote = await req('PUT', `/users/${STAFF_ID}`, { role: 'staff' }, boss);
    check('the demotion is accepted', demote.status === 200, `status=${demote.status}`);

    // Checked on /products, NOT /auth/me: /auth/me is flagged as
    // freshness-critical and deliberately skips the cache, so asking it would
    // pass whether or not the cached row was evicted and would prove nothing
    // about the bug this is guarding.
    const afterDemotion = await req('GET', '/products', null, bearer(inventoryToken));
    check('the demoted session is ended immediately, not after the cache TTL',
        afterDemotion.status === 401 && afterDemotion.data?.code === 'SESSION_REVOKED',
        `status=${afterDemotion.status} code=${afterDemotion.data?.code}`);

    // ---- a no-op save must NOT sign anyone out ----
    const quietToken = await login(DOOMED_EMAIL);
    const noop = await req('PUT', `/users/${DOOMED_ID}`, { role: 'staff' }, boss);
    check('re-saving the same role is accepted', noop.status === 200, `status=${noop.status}`);
    const afterNoop = await req('GET', '/customers', null, bearer(quietToken));
    check('re-saving the same role leaves the session alone',
        afterNoop.status === 200, `status=${afterNoop.status}`);

    // ---- deletion ----
    // The other half of the cache guard: there is no token_version left to
    // bump once the row is gone, so only the eviction can stop this token.
    // The /customers call above has just put this user's row in the cache,
    // which is exactly the state that made the bug visible: with the row warm
    // and no eviction, `protect` kept admitting the deleted account. Asked on
    // a cache-eligible route for the same reason as the demotion check.
    const deleted = await req('DELETE', `/users/${DOOMED_ID}`, null, boss);
    check('the deletion is accepted', deleted.status === 200, `status=${deleted.status}`);
    const afterDelete = await req('GET', '/customers', null, bearer(quietToken));
    check('a deleted account cannot keep using its token (cached row evicted)',
        afterDelete.status === 401, `status=${afterDelete.status}`);

    // ---- the version actually moved in the database ----
    const versions = await db.query('SELECT token_version FROM users WHERE id = $1', [BOSS_ID]);
    check('token_version is incremented in the database',
        (versions.rows[0]?.token_version ?? 0) >= 1, `token_version=${versions.rows[0]?.token_version}`);
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
