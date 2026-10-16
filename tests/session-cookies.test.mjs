/**
 * httpOnly session cookies and the CSRF guard.
 *
 * The session used to live in localStorage, where any XSS could read it. It is
 * now also issued as an httpOnly cookie, which buys XSS safety and costs CSRF
 * exposure — a cookie rides along on requests an attacker's page provokes,
 * where an Authorization header cannot. So the two things worth testing are
 * that the cookie really authenticates, and that a cookie-authenticated WRITE
 * is refused without the matching CSRF token.
 *
 * The other half is that none of this disturbed the Bearer clients: the
 * Flutter till, the mobile apps and every other suite in this directory send
 * a header, and they must stay exempt from the CSRF requirement.
 *
 * No cookie jar on purpose — set-cookie is parsed and the Cookie header is
 * built by hand, so what is actually being sent is explicit in each check.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/session-cookies.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `cookietest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const EMAIL = `cookie-${RUN}@test.local`;
const PASSWORD = 'cookietest-password-1';

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const db = new pg.Client({ connectionString: DATABASE_URL });

const seed = async () => {
    const hash = bcrypt.hashSync(PASSWORD, 10);
    await db.query(
        `INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`,
        [STORE_ID, `Cookie Test Store ${RUN}`],
    );
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1, 'Cookie Tester', $2, $3, 'admin', $4, true)`,
        [USER_ID, EMAIL, hash, STORE_ID],
    );
    await db.query(
        `INSERT INTO store_settings (store_id, name, tax_rate, currency, low_stock_threshold, enable_store_credit, is_online_store_enabled)
         VALUES ($1, 'Cookie Test Store', 0, '{"symbol":"K","code":"ZMW","position":"before"}', 5, true, true)`,
        [STORE_ID],
    );
};

const cleanup = async () => {
    await db.query(`DELETE FROM customers WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    await db.query(`DELETE FROM store_settings WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    await db.query(`DELETE FROM audit_logs WHERE store_id = $1`, [STORE_ID]).catch(() => {});
    await db.query(`DELETE FROM users WHERE current_store_id = $1`, [STORE_ID]).catch(() => {});
    await db.query(`DELETE FROM stores WHERE id = $1`, [STORE_ID]).catch(() => {});
};

/** Pull the cookies out of a response's set-cookie headers. */
const parseSetCookie = (resp) => {
    const raw = typeof resp.headers.getSetCookie === 'function'
        ? resp.headers.getSetCookie()
        : [resp.headers.get('set-cookie')].filter(Boolean);
    const jar = {};
    for (const line of raw) {
        for (const piece of String(line).split(/,(?=[^;]+=)/)) {
            const first = piece.split(';')[0];
            const eq = first.indexOf('=');
            if (eq === -1) continue;
            jar[first.slice(0, eq).trim()] = {
                value: first.slice(eq + 1).trim(),
                attrs: piece.toLowerCase(),
            };
        }
    }
    return jar;
};

const cookieHeader = (jar, names) =>
    names.filter(n => jar[n]).map(n => `${n}=${jar[n].value}`).join('; ');

const main = async () => {
    await db.connect();
    await cleanup();
    await seed();

    // ---- signing in issues both cookies ----
    const loginResp = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    const loginBody = await loginResp.json();
    const jar = parseSetCookie(loginResp);

    check('login succeeds', loginResp.status === 200, `status=${loginResp.status}`);
    check('login sets the session cookie', !!jar.sp_session);
    check('the session cookie is httpOnly (a script cannot read it)',
        !!jar.sp_session?.attrs.includes('httponly'));
    check('login sets the CSRF cookie', !!jar.sp_csrf);
    check('the CSRF cookie is readable by script (that is the mechanism)',
        !!jar.sp_csrf && !jar.sp_csrf.attrs.includes('httponly'));
    check('the token is still in the body for native clients', !!loginBody?.token);
    check('the session cookie holds that same token', jar.sp_session?.value === loginBody?.token);

    const sessionOnly = cookieHeader(jar, ['sp_session']);
    const bothCookies = cookieHeader(jar, ['sp_session', 'sp_csrf']);
    const csrf = jar.sp_csrf?.value;
    const bearer = { Authorization: `Bearer ${loginBody?.token}` };

    // ---- the cookie authenticates on its own ----
    const meByCookie = await fetch(`${API}/auth/me`, { headers: { Cookie: sessionOnly } });
    check('the cookie alone authenticates a GET', meByCookie.status === 200, `status=${meByCookie.status}`);

    const meAnon = await fetch(`${API}/auth/me`);
    check('no credential is still 401', meAnon.status === 401, `status=${meAnon.status}`);

    // ---- CSRF: the point of the exercise ----
    const writeBody = { name: 'CSRF Probe', phone: `+2609${Date.now()}`.slice(0, 13) };
    const post = (headers) => fetch(`${API}/customers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ ...writeBody, phone: `+2609${Math.floor(Math.random() * 10 ** 8)}` }),
    });

    const noCsrf = await post({ Cookie: bothCookies });
    check('a cookie-authenticated write with NO CSRF header is refused',
        noCsrf.status === 403, `status=${noCsrf.status}`);

    const wrongCsrf = await post({ Cookie: bothCookies, 'X-CSRF-Token': 'not-the-right-value' });
    check('a cookie-authenticated write with a WRONG CSRF header is refused',
        wrongCsrf.status === 403, `status=${wrongCsrf.status}`);

    // A token that matches nothing in the request is not enough either: the
    // header has to equal the cookie, so sending only the header fails.
    const headerWithoutCookie = await post({ Cookie: sessionOnly, 'X-CSRF-Token': csrf });
    check('the CSRF cookie must be present too, not just the header',
        headerWithoutCookie.status === 403, `status=${headerWithoutCookie.status}`);

    const goodCsrf = await post({ Cookie: bothCookies, 'X-CSRF-Token': csrf });
    check('a cookie-authenticated write WITH the matching CSRF token succeeds',
        goodCsrf.status === 201 || goodCsrf.status === 200, `status=${goodCsrf.status}`);

    // ---- Bearer clients stay exempt ----
    const bearerWrite = await post(bearer);
    check('a Bearer write needs no CSRF token (native clients unaffected)',
        bearerWrite.status === 201 || bearerWrite.status === 200, `status=${bearerWrite.status}`);

    // ---- the header wins when both are sent ----
    const bogusCookie = 'sp_session=not-a-real-token';
    const headerWins = await fetch(`${API}/auth/me`, {
        headers: { ...bearer, Cookie: bogusCookie },
    });
    check('a valid header beats a junk cookie', headerWins.status === 200, `status=${headerWins.status}`);

    // ---- a stale cookie must not block signing in again ----
    const reLogin = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: bothCookies },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
    });
    check('login is CSRF-exempt, so a leftover cookie cannot lock you out',
        reLogin.status === 200, `status=${reLogin.status}`);

    // ---- changing the password keeps THIS cookie alive ----
    const changed = await fetch(`${API}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: bothCookies, 'X-CSRF-Token': csrf },
        body: JSON.stringify({ currentPassword: PASSWORD, newPassword: 'cookietest-password-2' }),
    });
    const changedJar = parseSetCookie(changed);
    check('changing the password succeeds', changed.status === 200, `status=${changed.status}`);
    check('it reissues the session cookie', !!changedJar.sp_session);
    const afterChange = await fetch(`${API}/auth/me`, {
        headers: { Cookie: cookieHeader(changedJar, ['sp_session']) },
    });
    check('the reissued cookie still works (not signed out by your own change)',
        afterChange.status === 200, `status=${afterChange.status}`);
    const oldCookieAfterChange = await fetch(`${API}/auth/me`, { headers: { Cookie: sessionOnly } });
    check('the pre-change cookie is revoked',
        oldCookieAfterChange.status === 401, `status=${oldCookieAfterChange.status}`);

    // ---- logout clears the cookie server-side ----
    const freshJar = changedJar;
    const logout = await fetch(`${API}/auth/logout`, {
        method: 'POST',
        headers: { Cookie: cookieHeader(freshJar, ['sp_session', 'sp_csrf']) },
    });
    const clearedJar = parseSetCookie(logout);
    check('logout succeeds', logout.status === 200, `status=${logout.status}`);
    check('logout clears the session cookie',
        clearedJar.sp_session !== undefined && clearedJar.sp_session.value === '',
        `value="${clearedJar.sp_session?.value}"`);
    check('logout clears the CSRF cookie',
        clearedJar.sp_csrf !== undefined && clearedJar.sp_csrf.value === '',
        `value="${clearedJar.sp_csrf?.value}"`);
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
