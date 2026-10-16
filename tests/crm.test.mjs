/**
 * Store-facing CRM endpoints, end to end.
 *
 * The loyalty program, its redemption ledger and the message templates used to
 * live in the browser's localStorage, so these checks are mostly about what
 * moving them server-side has to guarantee: the program follows the STORE (not
 * the device), one store cannot read or redeem against another's customers, and
 * redeeming is atomic — the ledger row and the store credit land together, and
 * the server, not the client, decides how much credit the points buy.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/crm.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `crmtest-${Date.now()}`;
const STORE_A = `store-a-${RUN}`;
const STORE_B = `store-b-${RUN}`;
const ADMIN_A = `admin-a-${RUN}`;
const STAFF_A = `staff-a-${RUN}`;
const ADMIN_B = `admin-b-${RUN}`;
const CUST_A = `cust-a-${RUN}`;
const CUST_B = `cust-b-${RUN}`;
const SALE_A = `sale-a-${RUN}`;
const PASSWORD = 'crmtest-password-1';

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
    return { status: r.status, data };
};

const bearer = token => ({ Authorization: `Bearer ${token}` });

const db = new pg.Client({ connectionString: DATABASE_URL });

const seedUser = async (id, storeId, role) => {
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE)`,
        [id, id, `${id}@test.local`, await bcrypt.hash(PASSWORD, 10), role, storeId],
    );
};

const cleanup = async () => {
    const stores = [STORE_A, STORE_B];
    const users = [ADMIN_A, STAFF_A, ADMIN_B];
    await db.query('DELETE FROM loyalty_points WHERE store_id = ANY($1)', [stores]).catch(() => {});
    await db.query('DELETE FROM loyalty_redemptions WHERE store_id = ANY($1)', [stores]).catch(() => {});
    await db.query('DELETE FROM loyalty_programs WHERE store_id = ANY($1)', [stores]).catch(() => {});
    await db.query('DELETE FROM crm_message_templates WHERE store_id = ANY($1)', [stores]).catch(() => {});
    await db.query('DELETE FROM customer_emails WHERE store_id = ANY($1)', [stores]).catch(() => {});
    await db.query('DELETE FROM sales WHERE store_id = ANY($1)', [stores]).catch(() => {});
    await db.query('DELETE FROM customers WHERE store_id = ANY($1)', [stores]).catch(() => {});
    await db.query('DELETE FROM users WHERE id = ANY($1)', [users]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = ANY($1)', [stores]).catch(() => {});
};

const main = async () => {
    await db.connect();
    await cleanup();

    for (const [store, owner] of [[STORE_A, ADMIN_A], [STORE_B, ADMIN_B]]) {
        await db.query('INSERT INTO stores (id, name, owner_id, status) VALUES ($1,$2,$3,$4)',
            [store, `Store ${store}`, owner, 'active']);
    }
    await seedUser(ADMIN_A, STORE_A, 'admin');
    await seedUser(STAFF_A, STORE_A, 'staff');
    await seedUser(ADMIN_B, STORE_B, 'admin');

    // Store A's customer has K2,500 of attributed sales. With the default earn
    // rate (1 pt / 10) that is 250 points — two 100-point blocks at K5 = K10.
    for (const [cust, store] of [[CUST_A, STORE_A], [CUST_B, STORE_B]]) {
        await db.query(
            `INSERT INTO customers (id, name, email, phone, created_at, store_credit, account_balance, store_id)
             VALUES ($1,$2,$3,$4,NOW(),0,0,$5)`,
            [cust, `Customer ${cust}`, `${cust}@test.local`, '+260970000001', store],
        );
    }
    await db.query(
        `INSERT INTO sales (transaction_id, timestamp, subtotal, tax, discount, total, amount_paid, payment_status, customer_id, store_id)
         VALUES ($1, NOW(), 2500, 0, 0, 2500, 2500, 'paid', $2, $3)`,
        [SALE_A, CUST_A, STORE_A],
    );
    // Points are an append-only ledger written when the sale is rung up (see
    // tests/loyalty-points.test.mjs), not derived from spend at read time —
    // so a sale seeded straight into the table needs its earn row too.
    await db.query(
        `INSERT INTO loyalty_points (id, store_id, customer_id, sale_id, reason, points, earn_spend_per_point, basis_amount)
         VALUES ($1,$2,$3,$4,'sale',250,10,2500)`,
        [`lpt-${RUN}`, STORE_A, CUST_A, SALE_A],
    );

    const login = async id => {
        const r = await req('POST', '/auth/login', { email: `${id}@test.local`, password: PASSWORD });
        if (r.status !== 200 || !r.data?.token) throw new Error(`login failed for ${id}: ${r.status} ${JSON.stringify(r.data)}`);
        return r.data.token;
    };
    const tokenA = await login(ADMIN_A);
    const tokenStaffA = await login(STAFF_A);
    const tokenB = await login(ADMIN_B);

    /* 1. the loyalty program ------------------------------------------ */
    const prog0 = await req('GET', '/crm/loyalty/program', null, bearer(tokenA));
    check('an unconfigured store gets the default program',
        prog0.status === 200 && prog0.data?.enabled === true && prog0.data?.earnSpendPerPoint === 10,
        JSON.stringify(prog0.data));

    const saved = await req('PUT', '/crm/loyalty/program', {
        enabled: true, earnSpendPerPoint: 20, redeemPointsPerUnit: 50,
        redeemValuePerUnit: 2.5, minRedeemPoints: 10, expiryEnabled: false, expiryMonths: 12,
    }, bearer(tokenA));
    check('the program saves', saved.status === 200 && saved.data?.earnSpendPerPoint === 20, JSON.stringify(saved.data));

    const reread = await req('GET', '/crm/loyalty/program', null, bearer(tokenA));
    check('the saved program survives a re-read',
        reread.data?.earnSpendPerPoint === 20 && reread.data?.redeemPointsPerUnit === 50,
        JSON.stringify(reread.data));

    const progB = await req('GET', '/crm/loyalty/program', null, bearer(tokenB));
    check('another store still sees its own (default) program',
        progB.data?.earnSpendPerPoint === 10, JSON.stringify(progB.data));

    // A zero earn rate would divide by zero when awarding points.
    const clamped = await req('PUT', '/crm/loyalty/program', { earnSpendPerPoint: 0, redeemPointsPerUnit: 0 }, bearer(tokenA));
    check('a zero earn rate / redemption block is clamped to 1',
        clamped.data?.earnSpendPerPoint >= 1 && clamped.data?.redeemPointsPerUnit >= 1,
        JSON.stringify(clamped.data));

    const staffWrite = await req('PUT', '/crm/loyalty/program', { enabled: false }, bearer(tokenStaffA));
    check('staff cannot change the program', staffWrite.status === 403, String(staffWrite.status));

    /* 2. redeeming ---------------------------------------------------- */
    // Back to the defaults: 2500 spend / 10 = 250 pts → 2 blocks of 100 = K10.
    await req('PUT', '/crm/loyalty/program', {
        enabled: true, earnSpendPerPoint: 10, redeemPointsPerUnit: 100,
        redeemValuePerUnit: 5, minRedeemPoints: 0, expiryEnabled: false, expiryMonths: 12,
    }, bearer(tokenA));

    const redeem = await req('POST', '/crm/loyalty/redemptions', { customerId: CUST_A }, bearer(tokenA));
    check('redeem grants the whole-block value only',
        redeem.status === 201 && redeem.data?.redemption?.points === 200 && Number(redeem.data?.redemption?.value) === 10,
        JSON.stringify(redeem.data?.redemption));
    check('the store credit is granted in the same call',
        Number(redeem.data?.customer?.storeCredit) === 10, JSON.stringify(redeem.data?.customer?.storeCredit));

    const credit = await db.query('SELECT store_credit FROM customers WHERE id = $1', [CUST_A]);
    check('the credit is actually persisted', Number(credit.rows[0].store_credit) === 10, String(credit.rows[0].store_credit));

    const ledger = await req('GET', `/crm/loyalty/redemptions?customerId=${CUST_A}`, null, bearer(tokenA));
    check('the redemption is in the ledger with the customer name',
        ledger.status === 200 && ledger.data.length === 1 && !!ledger.data[0].customerName,
        JSON.stringify(ledger.data));

    // 250 earned − 200 redeemed = 50 left, less than one 100-point block.
    const again = await req('POST', '/crm/loyalty/redemptions', { customerId: CUST_A }, bearer(tokenA));
    check('a second redeem with too few points left is refused',
        again.status === 409 && again.data?.code === 'INSUFFICIENT_POINTS', `${again.status} ${JSON.stringify(again.data)}`);

    const ledgerAfter = await db.query('SELECT COUNT(*)::int AS n FROM loyalty_redemptions WHERE customer_id = $1', [CUST_A]);
    check('the refused redeem wrote no ledger row', ledgerAfter.rows[0].n === 1, String(ledgerAfter.rows[0].n));

    const creditAfter = await db.query('SELECT store_credit FROM customers WHERE id = $1', [CUST_A]);
    check('the refused redeem granted no credit', Number(creditAfter.rows[0].store_credit) === 10, String(creditAfter.rows[0].store_credit));

    const crossRedeem = await req('POST', '/crm/loyalty/redemptions', { customerId: CUST_A }, bearer(tokenB));
    check("another store cannot redeem against this store's customer",
        crossRedeem.status === 404, String(crossRedeem.status));

    const crossLedger = await req('GET', '/crm/loyalty/redemptions', null, bearer(tokenB));
    check("another store's ledger is empty", crossLedger.status === 200 && crossLedger.data.length === 0,
        JSON.stringify(crossLedger.data));

    await req('PUT', '/crm/loyalty/program', { enabled: false }, bearer(tokenA));
    const paused = await req('POST', '/crm/loyalty/redemptions', { customerId: CUST_A }, bearer(tokenA));
    check('a paused program refuses redemptions', paused.status === 409 && paused.data?.code === 'LOYALTY_PAUSED',
        `${paused.status} ${JSON.stringify(paused.data)}`);

    /* 3. message templates -------------------------------------------- */
    const tpls = await req('GET', '/crm/templates', null, bearer(tokenA));
    check('a new store is seeded with default templates',
        tpls.status === 200 && tpls.data.length >= 5 && tpls.data.every(t => t.id && t.label && t.body),
        String(tpls.data?.length));

    const created = await req('POST', '/crm/templates', { label: `T ${RUN}`, body: 'Hi [Name] — [Store]' }, bearer(tokenA));
    check('a template is created', created.status === 201 && !!created.data?.id, JSON.stringify(created.data));

    const updated = await req('PUT', `/crm/templates/${created.data.id}`, { label: `T2 ${RUN}`, body: 'Updated [Name]' }, bearer(tokenA));
    check('a template is updated', updated.status === 200 && updated.data?.label === `T2 ${RUN}`, JSON.stringify(updated.data));

    const blank = await req('POST', '/crm/templates', { label: '  ', body: '' }, bearer(tokenA));
    check('a blank template is rejected', blank.status === 400, String(blank.status));

    const crossEdit = await req('PUT', `/crm/templates/${created.data.id}`, { label: 'x', body: 'y' }, bearer(tokenB));
    check("another store cannot edit this store's template", crossEdit.status === 404, String(crossEdit.status));

    const crossDelete = await req('DELETE', `/crm/templates/${created.data.id}`, null, bearer(tokenB));
    check("another store cannot delete this store's template", crossDelete.status === 404, String(crossDelete.status));

    const deleted = await req('DELETE', `/crm/templates/${created.data.id}`, null, bearer(tokenA));
    check('the owning store deletes its template', deleted.status === 200, String(deleted.status));

    const listAfter = await req('GET', '/crm/templates', null, bearer(tokenA));
    check('the deleted template is gone', !listAfter.data.some(t => t.id === created.data.id));

    /* 4. customer email + outreach ------------------------------------ */
    // Whether the mail actually leaves depends on this environment's transport
    // (the local docker stack has no working SMTP credentials), so these checks
    // are about the contract: the request is accepted or honestly reported as
    // undelivered, and either way the attempt is logged against the store.
    const email = await req('POST', '/crm/email', { customerId: CUST_A, subject: `Hi ${RUN}`, message: 'Hello there' }, bearer(tokenA));
    const delivered = email.status === 200 && email.data?.success === true;
    const refused = email.status === 502 && email.data?.success === false;
    check('an email to a customer either sends or is honestly reported as failed',
        delivered || refused, `${email.status} ${JSON.stringify(email.data)}`);

    const logged = await db.query('SELECT recipient, subject, status FROM customer_emails WHERE store_id = $1', [STORE_A]);
    check('the email attempt is recorded against the store with its outcome',
        logged.rowCount === 1 && logged.rows[0].recipient === `${CUST_A}@test.local`
        && logged.rows[0].status === (delivered ? 'sent' : 'failed'),
        JSON.stringify(logged.rows));

    const emptyBody = await req('POST', '/crm/email', { customerId: CUST_A, message: '   ' }, bearer(tokenA));
    check('an empty email body is rejected', emptyBody.status === 400, String(emptyBody.status));

    const crossEmail = await req('POST', '/crm/email', { customerId: CUST_A, message: 'hi' }, bearer(tokenB));
    check("another store cannot email this store's customer", crossEmail.status === 404, String(crossEmail.status));

    // The stored address wins, so a spoofed `to` cannot redirect the email.
    await req('POST', '/crm/email', { customerId: CUST_A, to: 'attacker@evil.test', message: 'hi' }, bearer(tokenA));
    const spoofRow = await db.query('SELECT recipient FROM customer_emails WHERE store_id = $1 ORDER BY created_at DESC LIMIT 1', [STORE_A]);
    check('a client-supplied recipient cannot override the stored address',
        spoofRow.rows[0].recipient === `${CUST_A}@test.local`,
        spoofRow.rows[0].recipient);

    const outreach = await req('GET', `/crm/outreach?customerId=${CUST_A}`, null, bearer(tokenA));
    check('the outreach timeline shows the emails',
        outreach.status === 200 && outreach.data.length === 2 && outreach.data.every(e => e.channel === 'email'),
        JSON.stringify(outreach.data.map(e => e.channel)));

    const crossOutreach = await req('GET', `/crm/outreach?customerId=${CUST_A}`, null, bearer(tokenB));
    check("another store sees nothing in this customer's timeline",
        crossOutreach.status === 200 && crossOutreach.data.length === 0, JSON.stringify(crossOutreach.data));

    /* 5. creditLimit on customer CREATE (used to be dropped) ---------- */
    const newCust = await req('POST', '/customers', {
        name: `Credit ${RUN}`, email: `credit-${RUN}@test.local`, creditLimit: 750,
    }, bearer(tokenA));
    check('a credit limit set while ADDING a customer is kept',
        newCust.status === 201 && Number(newCust.data?.creditLimit) === 750,
        JSON.stringify(newCust.data?.creditLimit));

    const noLimit = await req('POST', '/customers', { name: `NoCredit ${RUN}`, creditLimit: '' }, bearer(tokenA));
    check('a blank credit limit means no credit line',
        noLimit.status === 201 && (noLimit.data?.creditLimit === null || noLimit.data?.creditLimit === undefined),
        JSON.stringify(noLimit.data?.creditLimit));

    /* 6. auth --------------------------------------------------------- */
    const anon = await req('GET', '/crm/loyalty/program');
    check('the program needs a token', anon.status === 401, String(anon.status));
    const anonRedeem = await req('POST', '/crm/loyalty/redemptions', { customerId: CUST_A });
    check('redeeming needs a token', anonRedeem.status === 401, String(anonRedeem.status));
};

main()
    .catch(err => { console.error('\nFATAL', err); results.push({ name: 'suite ran', ok: false }); })
    .finally(async () => {
        await cleanup().catch(() => {});
        await db.end().catch(() => {});
        const failed = results.filter(r => !r.ok);
        console.log(`\n${results.length - failed.length}/${results.length} passed`);
        if (failed.length) {
            console.log('Failed:');
            failed.forEach(f => console.log(` - ${f.name}`));
        }
        process.exit(failed.length ? 1 : 0);
    });
