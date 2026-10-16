/**
 * Loyalty points as an append-only ledger, end to end.
 *
 * Points used to be DERIVED at read time as `floor(lifetime spend / earn
 * rate)`, on both the client and the server. That made the earn rate
 * retroactive: raise it and every customer's balance shrinks, including
 * balances they were already shown and balances they have already partly
 * redeemed. So these checks are mostly about what must NOT move — a past
 * earning is fixed at the rate that produced it — plus the two events that may
 * legitimately take points back: a refund and a cancelled order.
 *
 * Usage:
 *   API_URL=http://localhost:5000/api \
 *   DATABASE_URL=postgresql://postgres:password@localhost:5432/salepilot \
 *   node tests/loyalty-points.test.mjs
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `lpt-${Date.now()}`;
const STORE = `store-${RUN}`;
const ADMIN = `admin-${RUN}`;
const CUST = `cust-${RUN}`;
const PRODUCT = `prod-${RUN}`;
const OLD_SALE = `oldsale-${RUN}`;
const PASSWORD = 'lpt-password-1';

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

/** Everything the ledger holds for our customer. */
const ledger = async () => (await db.query(
    'SELECT reason, points, earn_spend_per_point, sale_id FROM loyalty_points WHERE store_id = $1 ORDER BY earned_at, id',
    [STORE],
)).rows;

const balance = async () => Number((await db.query(
    'SELECT COALESCE(SUM(points), 0) AS p FROM loyalty_points WHERE store_id = $1 AND customer_id = $2',
    [STORE, CUST],
)).rows[0].p);

const setRate = (token, rate) => req('PUT', '/crm/loyalty/program', {
    enabled: true, earnSpendPerPoint: rate, redeemPointsPerUnit: 100,
    redeemValuePerUnit: 5, minRedeemPoints: 0, expiryEnabled: false, expiryMonths: 12,
}, bearer(token));

/** Ring up a sale through the real endpoint, so the award hook runs. */
const sell = (token, { price, quantity = 1 }) => req('POST', '/sales', {
    cart: [{ productId: PRODUCT, name: 'Widget', sku: `SKU-${RUN}`, price, quantity, costPrice: 0 }],
    customerId: CUST,
    subtotal: price * quantity,
    discount: 0,
    tax: 0,
    total: price * quantity,
    amountPaid: price * quantity,
    paymentStatus: 'paid',
    payments: [{ amount: price * quantity, method: 'Cash' }],
}, bearer(token));

const cleanup = async () => {
    await db.query('DELETE FROM loyalty_points WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM loyalty_redemptions WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM loyalty_programs WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM crm_message_templates WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM return_items WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM returns WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM journal_entry_lines WHERE journal_entry_id IN (SELECT id FROM journal_entries WHERE store_id = $1)', [STORE]).catch(() => {});
    await db.query('DELETE FROM journal_entries WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM payments WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM sale_items WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM sales WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM products WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM accounts WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM customers WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM audit_logs WHERE user_id = $1', [ADMIN]).catch(() => {});
    await db.query('DELETE FROM store_settings WHERE store_id = $1', [STORE]).catch(() => {});
    await db.query('DELETE FROM users WHERE id = $1', [ADMIN]).catch(() => {});
    await db.query('DELETE FROM stores WHERE id = $1', [STORE]).catch(() => {});
};

const main = async () => {
    await db.connect();
    await cleanup();

    await db.query('INSERT INTO stores (id, name, owner_id, status) VALUES ($1,$2,$3,$4)',
        [STORE, `Store ${RUN}`, ADMIN, 'active']);
    await db.query(
        `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
         VALUES ($1,$2,$3,$4,'admin',$5,TRUE)`,
        [ADMIN, ADMIN, `${ADMIN}@test.local`, await bcrypt.hash(PASSWORD, 10), STORE],
    );
    await db.query(
        `INSERT INTO customers (id, name, email, created_at, store_credit, account_balance, store_id)
         VALUES ($1,$2,$3,NOW(),0,0,$4)`,
        [CUST, `Customer ${RUN}`, `${CUST}@test.local`, STORE],
    );
    await db.query(
        `INSERT INTO products (id, name, description, sku, price, cost_price, stock, status, store_id, image_urls)
         VALUES ($1,'Widget','test',$2,100,40,500,'active',$3,'{}')`,
        [PRODUCT, `SKU-${RUN}`, STORE],
    );

    const login = await req('POST', '/auth/login', { email: `${ADMIN}@test.local`, password: PASSWORD });
    if (login.status !== 200 || !login.data?.token) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.data)}`);
    const token = login.data.token;

    /* 1. a sale awards points at the rate in force ---------------------- */
    await setRate(token, 10);
    const sale1 = await sell(token, { price: 125, quantity: 2 }); // two units, so each half can be returned separately
    check('the sale is recorded', sale1.status === 201, `${sale1.status} ${JSON.stringify(sale1.data).slice(0, 160)}`);
    const sale1Id = sale1.data?.transactionId;
    const sale1Total = Number(sale1.data?.total);

    const afterSale1 = await ledger();
    const earn1 = afterSale1.find(r => r.sale_id === sale1Id);
    check('the sale writes one earn row at the current rate',
        !!earn1 && earn1.reason === 'sale' && Number(earn1.earn_spend_per_point) === 10
        && earn1.points === Math.floor(sale1Total / 10),
        JSON.stringify(earn1));

    /* 2. changing the rate does NOT re-price past earnings --------------- */
    const before = await balance();
    await setRate(token, 50);
    const afterRateChange = await balance();
    check('raising the earn rate leaves earned points untouched',
        afterRateChange === before, `${before} -> ${afterRateChange}`);

    const reported = await req('GET', `/crm/loyalty/points?customerId=${CUST}`, null, bearer(token));
    check('the API reports the ledger balance, not a re-derived one',
        reported.status === 200 && reported.data[0]?.points === before,
        JSON.stringify(reported.data));

    /* 3. the NEW rate applies to the NEXT sale only --------------------- */
    const sale2 = await sell(token, { price: 125, quantity: 2 });
    const sale2Id = sale2.data?.transactionId;
    const sale2Total = Number(sale2.data?.total);
    const earn2 = (await ledger()).find(r => r.sale_id === sale2Id);
    check('the next sale earns at the new rate',
        !!earn2 && Number(earn2.earn_spend_per_point) === 50 && earn2.points === Math.floor(sale2Total / 50),
        JSON.stringify(earn2));
    check('the two sales earned different points for the same basket',
        earn1.points !== earn2.points, `${earn1.points} vs ${earn2.points}`);

    /* 4. a return reverses, at the ORIGINAL sale's rate ------------------ */
    // Refund half of sale 1 while the live rate is 50: reversing at today's
    // rate would claw back far less than was given.
    const halfOfSale1 = Math.round((sale1Total / 2) * 100) / 100;
    const ret = await req('POST', '/returns', {
        originalSaleId: sale1Id,
        returnedItems: [{ productId: PRODUCT, productName: 'Widget', quantity: 1, reason: 'test', addToStock: true }],
        refundAmount: halfOfSale1,
        refundMethod: 'cash',
    }, bearer(token));
    check('the return is recorded', ret.status === 201, `${ret.status} ${JSON.stringify(ret.data).slice(0, 160)}`);

    const reversal = (await ledger()).find(r => r.reason === 'return');
    check('the return writes a negative row at the ORIGINAL rate',
        !!reversal && Number(reversal.earn_spend_per_point) === 10
        && reversal.points === -Math.round(earn1.points * (halfOfSale1 / sale1Total)),
        JSON.stringify(reversal));

    const balAfterReturn = await balance();
    check('the balance drops by exactly the reversal',
        balAfterReturn === earn1.points + earn2.points + reversal.points,
        `${balAfterReturn}`);

    /* 5. reversals can never exceed what the sale earned ---------------- */
    // Refund the REST of sale 1; cumulative reversal must stop at earn1.points.
    const restOfSale1 = Math.round((sale1Total - halfOfSale1) * 100) / 100;
    const ret2 = await req('POST', '/returns', {
        originalSaleId: sale1Id,
        returnedItems: [{ productId: PRODUCT, productName: 'Widget', quantity: 1, reason: 'test', addToStock: true }],
        refundAmount: restOfSale1,
        refundMethod: 'cash',
    }, bearer(token));
    const reversedTotal = Number((await db.query(
        `SELECT COALESCE(SUM(-points), 0) AS p FROM loyalty_points
          WHERE sale_id = $1 AND reason IN ('return','adjustment')`, [sale1Id],
    )).rows[0].p);
    check('fully refunding a sale reverses all of its points and no more',
        ret2.status === 201 && reversedTotal === earn1.points, `${reversedTotal} of ${earn1.points}`);

    const balFullyRefunded = await balance();
    check('a fully refunded sale contributes nothing to the balance',
        balFullyRefunded === earn2.points, `${balFullyRefunded} vs ${earn2.points}`);

    /* 6. a paused program awards nothing -------------------------------- */
    await req('PUT', '/crm/loyalty/program', { enabled: false }, bearer(token));
    const pausedSale = await sell(token, { price: 400 });
    const pausedRow = (await ledger()).find(r => r.sale_id === pausedSale.data?.transactionId);
    check('a sale while the program is paused earns no points', !pausedRow, JSON.stringify(pausedRow || null));
    await setRate(token, 10);

    /* 7. redeeming spends from the ledger ------------------------------- */
    // The balance is whatever sale 2 left; top it up past one 100-pt block.
    await sell(token, { price: 1000 });
    const beforeRedeem = await balance();
    const redeem = await req('POST', '/crm/loyalty/redemptions', { customerId: CUST }, bearer(token));
    check('redeeming against ledger points succeeds', redeem.status === 201,
        `${redeem.status} ${JSON.stringify(redeem.data).slice(0, 160)}`);
    check('redeeming does not touch the EARNED ledger (it is a separate table)',
        (await balance()) === beforeRedeem, `${beforeRedeem}`);
    check('the server reports the remaining balance as earned minus redeemed',
        redeem.data?.pointsBalance === beforeRedeem - redeem.data?.redemption?.points,
        `${redeem.data?.pointsBalance}`);

    /* 8. the backfill is idempotent ------------------------------------- */
    // Re-run exactly what init_db runs. Our sales already have earn rows, so a
    // second pass must insert nothing — otherwise every boot doubles balances.
    const countBefore = Number((await db.query('SELECT COUNT(*)::int AS n FROM loyalty_points WHERE store_id = $1', [STORE])).rows[0].n);
    await db.query(`
        INSERT INTO loyalty_points (id, store_id, customer_id, sale_id, reason, points, earn_spend_per_point, basis_amount, earned_at)
        SELECT 'lpt-bf-' || s.transaction_id, s.store_id, s.customer_id, s.transaction_id, 'backfill',
               FLOOR(s.total / COALESCE(NULLIF(p.earn_spend_per_point, 0), 10))::int,
               COALESCE(NULLIF(p.earn_spend_per_point, 0), 10), s.total, s.timestamp
        FROM sales s
        LEFT JOIN loyalty_programs p ON p.store_id = s.store_id
        WHERE s.customer_id IS NOT NULL AND s.store_id IS NOT NULL AND s.total > 0
          AND NOT EXISTS (SELECT 1 FROM loyalty_points lp WHERE lp.sale_id = s.transaction_id AND lp.reason IN ('sale','backfill'));
    `);
    const countAfter = Number((await db.query('SELECT COUNT(*)::int AS n FROM loyalty_points WHERE store_id = $1', [STORE])).rows[0].n);
    // The paused sale has no earn row, so the backfill legitimately adopts it —
    // that is the point of the backfill. Nothing that already earned may double.
    const dupes = Number((await db.query(
        `SELECT COUNT(*)::int AS n FROM (
            SELECT sale_id FROM loyalty_points
             WHERE store_id = $1 AND sale_id IS NOT NULL AND reason IN ('sale','backfill')
             GROUP BY sale_id HAVING COUNT(*) > 1) d`, [STORE],
    )).rows[0].n);
    check('re-running the backfill never doubles an existing earn row', dupes === 0, `${countBefore} -> ${countAfter}`);

    /* 9. a cancelled online order gives its points back ------------------ */
    const toCancel = await sell(token, { price: 600 });
    const cancelId = toCancel.data?.transactionId;
    const earnedOnCancelled = Number((await db.query(
        'SELECT COALESCE(SUM(points),0) AS p FROM loyalty_points WHERE sale_id = $1', [cancelId],
    )).rows[0].p);
    const cancelled = await req('PUT', `/sales/${cancelId}/fulfillment`, { status: 'cancelled' }, bearer(token));
    const netOnCancelled = Number((await db.query(
        'SELECT COALESCE(SUM(points),0) AS p FROM loyalty_points WHERE sale_id = $1', [cancelId],
    )).rows[0].p);
    check('cancelling a sale takes its points back',
        cancelled.status === 200 && earnedOnCancelled > 0 && netOnCancelled === 0,
        `${cancelled.status}: ${earnedOnCancelled} -> ${netOnCancelled}`);

    /* 10. cross-store isolation ----------------------------------------- */
    const leaked = await db.query(
        'SELECT COUNT(*)::int AS n FROM loyalty_points WHERE customer_id = $1 AND store_id <> $2', [CUST, STORE],
    );
    check('no points row escapes its store', leaked.rows[0].n === 0, String(leaked.rows[0].n));
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
