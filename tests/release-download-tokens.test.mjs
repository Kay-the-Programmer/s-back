/**
 * Release downloads via single-use tickets, end to end.
 *
 * The installer used to be read into a Blob in the browser so the bearer token
 * could travel in a header; that buffered a whole 300MB file (or an APK on a
 * phone) in memory. Now an authenticated call mints an opaque ticket and the
 * browser fetches it natively. The ticket is therefore the entire credential
 * for an unauthenticated endpoint, so these checks are about the ways it must
 * NOT be usable: twice, after expiry, for someone else's privileges, for an
 * unpublished build, or not at all.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/release-download-tokens.test.mjs
 */
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';
const RELEASE_DIR = process.env.RELEASE_DIR || path.resolve('uploads/releases');

const RUN = `dltest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const USER_ID = `user-${RUN}`;
const OTHER_ID = `other-${RUN}`;
const SUPER_ID = `super-${RUN}`;
const USER_EMAIL = `user-${RUN}@test.local`;
const OTHER_EMAIL = `other-${RUN}@test.local`;
const SUPER_EMAIL = `super-${RUN}@test.local`;
const PASSWORD = 'dltest-password-1';

const PUB_ID = `rel-pub-${RUN}`;
const UNPUB_ID = `rel-unpub-${RUN}`;
const PUB_FILE = `${RUN}-app.apk`;
const UNPUB_FILE = `${RUN}-draft.apk`;
const APK_BODY = 'PK\u0003\u0004 pretend-apk-bytes';

const results = [];
const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`);
};

const req = async (method, p, body, headers = {}) => {
    const r = await fetch(API + p, {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
};

const bearer = token => ({ Authorization: `Bearer ${token}` });

const db = new pg.Client({ connectionString: DATABASE_URL });

const seedUser = async (id, email, role) => {
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [id, id, email, await bcrypt.hash(PASSWORD, 10), role, role === 'superadmin' ? null : STORE_ID]
    );
};

const seedRelease = async (id, fileName, published) => {
    fs.writeFileSync(path.join(RELEASE_DIR, fileName), APK_BODY);
    await db.query(
        `INSERT INTO desktop_releases
            (id, version, platform, channel, file_name, storage_path, file_size, is_published)
         VALUES ($1,$2,'android','stable',$3,$3,$4,$5)`,
        [id, `0.0.${published ? "p" : "u"}${RUN.slice(-8)}`, fileName, Buffer.byteLength(APK_BODY), published]
    );
};

const cleanup = async () => {
    await db.query('DELETE FROM release_download_tokens WHERE user_id = ANY($1)', [[USER_ID, OTHER_ID, SUPER_ID]]).catch(() => {});
    await db.query('DELETE FROM desktop_releases WHERE id = ANY($1)', [[PUB_ID, UNPUB_ID]]).catch(() => {});
    await db.query('DELETE FROM users WHERE id = ANY($1)', [[USER_ID, OTHER_ID, SUPER_ID]]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = $1', [STORE_ID]).catch(() => {});
    for (const f of [PUB_FILE, UNPUB_FILE]) {
        try { fs.unlinkSync(path.join(RELEASE_DIR, f)); } catch { /* already gone */ }
    }
};

const main = async () => {
    await db.connect();
    fs.mkdirSync(RELEASE_DIR, { recursive: true });

    await db.query(
        `INSERT INTO stores (id, name, owner_id, status) VALUES ($1,$2,$3,'active')`,
        [STORE_ID, `Store ${RUN}`, USER_ID]
    );
    await seedUser(USER_ID, USER_EMAIL, 'admin');
    await seedUser(OTHER_ID, OTHER_EMAIL, 'admin');
    await seedUser(SUPER_ID, SUPER_EMAIL, 'superadmin');
    await seedRelease(PUB_ID, PUB_FILE, true);
    await seedRelease(UNPUB_ID, UNPUB_FILE, false);

    const login = async email => {
        const r = await req('POST', '/auth/login', { email, password: PASSWORD });
        if (r.status !== 200 || !r.data?.token) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
        return r.data.token;
    };
    const userToken = await login(USER_EMAIL);
    const superToken = await login(SUPER_EMAIL);

    /* 1. a ticket downloads once -------------------------------------- */
    const mint = await req('POST', `/releases/${PUB_ID}/download-token`, null, bearer(userToken));
    check('mint returns a ticket path', mint.status === 200 && /^\/releases\/file\/.+/.test(mint.data?.downloadPath || ''), JSON.stringify(mint.data));
    const ticketPath = mint.data?.downloadPath;
    check('ticket is not the session JWT', !String(ticketPath).includes(userToken));

    const before = (await db.query('SELECT download_count FROM desktop_releases WHERE id = $1', [PUB_ID])).rows[0].download_count;

    const dl = await fetch(API + ticketPath);
    const body = await dl.text();
    check('ticket downloads the file', dl.status === 200 && body === APK_BODY, `${dl.status} ${body.length}b`);
    check(
        'APK arrives as a package archive',
        (dl.headers.get('content-type') || '').includes('application/vnd.android.package-archive'),
        dl.headers.get('content-type') || ''
    );
    check(
        'filename is in Content-Disposition',
        (dl.headers.get('content-disposition') || '').includes(PUB_FILE),
        dl.headers.get('content-disposition') || ''
    );

    const after = (await db.query('SELECT download_count FROM desktop_releases WHERE id = $1', [PUB_ID])).rows[0].download_count;
    check('download counter still increments', Number(after) === Number(before) + 1, `${before} -> ${after}`);

    /* 2. replay is rejected ------------------------------------------- */
    const replay = await fetch(API + ticketPath);
    check('a used ticket is rejected', replay.status === 404, String(replay.status));

    /* 3. concurrent redemption: only one wins ------------------------- */
    const raceMint = await req('POST', `/releases/${PUB_ID}/download-token`, null, bearer(userToken));
    const racePath = raceMint.data?.downloadPath;
    const raced = await Promise.all([0, 1, 2, 3].map(() => fetch(API + racePath).then(r => r.status)));
    check('concurrent redemptions: exactly one 200', raced.filter(s => s === 200).length === 1, raced.join(','));

    /* 4. expiry ------------------------------------------------------- */
    const expMint = await req('POST', `/releases/${PUB_ID}/download-token`, null, bearer(userToken));
    const expToken = String(expMint.data?.downloadPath).split('/').pop();
    await db.query("UPDATE release_download_tokens SET expires_at = NOW() - INTERVAL '1 minute' WHERE token = $1", [expToken]);
    const expired = await fetch(`${API}/releases/file/${expToken}`);
    check('an expired ticket is rejected', expired.status === 404, String(expired.status));

    /* 5. unpublished builds stay superadmin-only ---------------------- */
    const unpubMint = await req('POST', `/releases/${UNPUB_ID}/download-token`, null, bearer(userToken));
    check('ordinary user cannot mint for an unpublished release', unpubMint.status === 404, String(unpubMint.status));

    const superMint = await req('POST', `/releases/${UNPUB_ID}/download-token`, null, bearer(superToken));
    check('superadmin can mint for an unpublished release', superMint.status === 200, String(superMint.status));

    /* 6. privileges are re-checked at redemption time ----------------- */
    // Demote the minter after minting: the ticket must not carry the old role.
    const demoteMint = await req('POST', `/releases/${UNPUB_ID}/download-token`, null, bearer(superToken));
    const demotePath = demoteMint.data?.downloadPath;
    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [SUPER_ID]);
    const demoted = await fetch(API + demotePath);
    check("a demoted minter's ticket no longer reaches an unpublished build", demoted.status === 404, String(demoted.status));
    await db.query("UPDATE users SET role = 'superadmin' WHERE id = $1", [SUPER_ID]);

    // And the superadmin's own ticket from step 5 does work.
    const superDl = await fetch(API + superMint.data.downloadPath);
    const superBody = await superDl.text();
    check('superadmin ticket downloads the unpublished build', superDl.status === 200 && superBody === APK_BODY, String(superDl.status));

    /* 7. no credential at all ----------------------------------------- */
    const anonMint = await req('POST', `/releases/${PUB_ID}/download-token`);
    check('anonymous cannot mint a ticket', anonMint.status === 401, String(anonMint.status));

    const anonLegacy = await fetch(`${API}/releases/${PUB_ID}/download`);
    check('anonymous cannot use the legacy download endpoint', anonLegacy.status === 401, String(anonLegacy.status));

    const madeUp = await fetch(`${API}/releases/file/not-a-real-ticket`);
    check('a made-up ticket is rejected', madeUp.status === 404, String(madeUp.status));

    /* 8. the legacy authenticated endpoint still works ---------------- */
    const legacy = await fetch(`${API}/releases/${PUB_ID}/download`, { headers: bearer(userToken) });
    const legacyBody = await legacy.text();
    check('legacy authenticated download still works', legacy.status === 200 && legacyBody === APK_BODY, String(legacy.status));
};

main()
    .then(async () => {
        await cleanup();
        await db.end();
        const failed = results.filter(r => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
        process.exit(failed.length ? 1 : 0);
    })
    .catch(async e => {
        console.error('\nSUITE ERROR:', e);
        await cleanup().catch(() => {});
        await db.end().catch(() => {});
        process.exit(1);
    });
