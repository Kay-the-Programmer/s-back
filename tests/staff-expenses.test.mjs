/**
 * Staff expense recording, end-to-end against the local backend.
 *
 * Staff hold `expenses:record`: they may record an expense and see the ones
 * they recorded — nothing else. What this pins down:
 *  1. Staff can read the account options needed by the recording form.
 *  2. Staff can record an expense, and it posts to the ledger like any other.
 *  3. Staff see their own expenses only — not a colleague's, not the admin's,
 *     and the totals they're shown match what they can see.
 *  4. Another staff member's expense is "not found", not "forbidden".
 *  5. Staff cannot edit or delete — those stay admin-only.
 *  6. Posted account ids are validated against the store and the account type.
 *  7. Admin still sees everything.
 */
import bcrypt from 'bcryptjs';
import pg from 'pg';

const API = (process.env.API_URL || 'http://localhost:5000/api').replace(/\/+$/, '');
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/salepilot';

const RUN = `exptest-${Date.now()}`;
const STORE_ID = `store-${RUN}`;
const OTHER_STORE_ID = `store-other-${RUN}`;
const ADMIN_ID = `user-admin-${RUN}`;
const STAFF_ID = `user-staff-${RUN}`;
const STAFF2_ID = `user-staff2-${RUN}`;
const EXPENSE_ACC = `acc-exp-${RUN}`;
const CASH_ACC = `acc-cash-${RUN}`;
const FOREIGN_ACC = `acc-foreign-${RUN}`;
const REVENUE_ACC = `acc-rev-${RUN}`;
const STOCK_ACC = `acc-stock-${RUN}`;
const PASSWORD = 'exptest-password-1';

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
    for (const [id, name] of [[STORE_ID, `Expense Test Store ${RUN}`], [OTHER_STORE_ID, `Other Store ${RUN}`]]) {
        await db.query(
            `INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')`,
            [id, name],
        );
    }
    const users = [
        [ADMIN_ID, 'Exp Test Owner', `admin-${RUN}@test.local`, 'admin'],
        [STAFF_ID, 'Exp Test Cashier', `staff-${RUN}@test.local`, 'staff'],
        [STAFF2_ID, 'Exp Test Cashier Two', `staff2-${RUN}@test.local`, 'staff'],
    ];
    for (const [id, name, email, role] of users) {
        await db.query(
            `INSERT INTO users (id, name, email, password_hash, role, current_store_id, is_verified)
             VALUES ($1, $2, $3, $4, $5, $6, true)`,
            [id, name, email, hash, role, STORE_ID],
        );
    }
    const accounts = [
        [EXPENSE_ACC, 'Test Transport', '6100', 'expense', null, true, STORE_ID],
        [CASH_ACC, 'Test Petty Cash', '1010', 'asset', 'cash', true, STORE_ID],
        // An asset that isn't a way to pay — must not be offered or accepted.
        [STOCK_ACC, 'Test Inventory', '1200', 'asset', 'inventory', true, STORE_ID],
        [REVENUE_ACC, 'Test Sales Revenue', '4000', 'revenue', null, false, STORE_ID],
        [FOREIGN_ACC, 'Other Store Expense', '6100', 'expense', null, true, OTHER_STORE_ID],
    ];
    for (const [id, name, number, type, subType, debitNormal, storeId] of accounts) {
        await db.query(
            `INSERT INTO accounts (id, name, number, type, sub_type, is_debit_normal, balance, store_id)
             VALUES ($1, $2, $3, $4, $5, $6, 0, $7)`,
            [id, name, number, type, subType, debitNormal, storeId],
        );
    }
};

const cleanup = async () => {
    for (const storeId of [STORE_ID, OTHER_STORE_ID]) {
        for (const q of [
            [`DELETE FROM journal_entry_lines WHERE store_id = $1`, [storeId]],
            [`DELETE FROM journal_entries WHERE store_id = $1`, [storeId]],
            [`DELETE FROM expenses WHERE store_id = $1`, [storeId]],
            [`DELETE FROM audit_logs WHERE store_id = $1`, [storeId]],
            [`DELETE FROM accounts WHERE store_id = $1`, [storeId]],
            [`DELETE FROM users WHERE current_store_id = $1`, [storeId]],
            [`DELETE FROM stores WHERE id = $1`, [storeId]],
        ]) {
            try { await db.query(q[0], q[1]); } catch { /* table may not exist */ }
        }
    }
};

const login = async (email) => {
    const r = await req('POST', '/auth/login', { email, password: PASSWORD });
    if (r.status !== 200 || !r.data?.token) {
        throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.data)}`);
    }
    return { Authorization: `Bearer ${r.data.token}` };
};

const expensePayload = (description, amount) => ({
    date: new Date().toISOString().slice(0, 10),
    description,
    amount,
    expenseAccountId: EXPENSE_ACC,
    expenseAccountName: 'Test Transport',
    paymentAccountId: CASH_ACC,
    paymentAccountName: 'Test Petty Cash',
    category: 'Transport',
});

const run = async () => {
    await db.connect();
    await cleanup();
    await seed();

    const admin = await login(`admin-${RUN}@test.local`);
    const staff = await login(`staff-${RUN}@test.local`);
    const staff2 = await login(`staff2-${RUN}@test.local`);

    // 1. The recording form's account options, without chart-of-accounts access.
    const opts = await req('GET', '/expenses/accounts', null, staff);
    check('staff can read expense account options', opts.status === 200, `status ${opts.status}`);
    check(
        'options list the expense account and the cash account',
        opts.data?.expenseAccounts?.some(a => a.id === EXPENSE_ACC) &&
        opts.data?.paymentAccounts?.some(a => a.id === CASH_ACC),
        JSON.stringify(opts.data)?.slice(0, 160),
    );
    check(
        'options exclude accounts that are neither a category nor a way to pay',
        !JSON.stringify(opts.data || {}).includes(REVENUE_ACC) &&
        !JSON.stringify(opts.data || {}).includes(STOCK_ACC),
    );

    // 2. Recording.
    const created = await req('POST', '/expenses', expensePayload('Staff taxi fare', 45.5), staff);
    check('staff can record an expense', created.status === 201, `status ${created.status} ${JSON.stringify(created.data).slice(0, 120)}`);
    const expenseId = created.data?.id;
    check('the expense is stamped with the recording user', created.data?.createdBy === STAFF_ID, created.data?.createdBy);

    const journal = await db.query(
        `SELECT
            COALESCE(SUM(amount) FILTER (WHERE type = 'debit'), 0) AS debits,
            COALESCE(SUM(amount) FILTER (WHERE type = 'credit'), 0) AS credits
         FROM journal_entry_lines WHERE store_id = $1`,
        [STORE_ID],
    );
    check(
        'the expense posted a balanced journal entry',
        Number(journal.rows[0].debits) === 45.5 && Number(journal.rows[0].credits) === 45.5,
        `debits ${journal.rows[0].debits} credits ${journal.rows[0].credits}`,
    );

    // Expenses recorded by other people.
    const adminExpense = await req('POST', '/expenses', expensePayload('Owner rent payment', 1000), admin);
    const otherStaffExpense = await req('POST', '/expenses', expensePayload('Colleague airtime', 20), staff2);
    check('admin and a second cashier can also record', adminExpense.status === 201 && otherStaffExpense.status === 201);

    // 3 + 4. Scoping.
    const staffList = await req('GET', '/expenses', null, staff);
    const staffItems = staffList.data?.items ?? [];
    check(
        'staff see only what they recorded',
        staffItems.length === 1 && staffItems[0].id === expenseId,
        `${staffItems.length} item(s)`,
    );
    check(
        'the totals shown to staff cover only their own expenses',
        staffList.data?.totalCount === 1 && Number(staffList.data?.totalAmount) === 45.5,
        `count ${staffList.data?.totalCount} amount ${staffList.data?.totalAmount}`,
    );
    const peek = await req('GET', `/expenses/${adminExpense.data?.id}`, null, staff);
    check("another user's expense reads as not found", peek.status === 404, `status ${peek.status}`);

    // 5. No editing, no deleting.
    const edit = await req('PUT', `/expenses/${expenseId}`, expensePayload('Edited', 999), staff);
    check('staff cannot edit an expense', edit.status === 403, `status ${edit.status}`);
    const del = await req('DELETE', `/expenses/${expenseId}`, null, staff);
    check('staff cannot delete an expense', del.status === 403, `status ${del.status}`);

    // 6. Account validation.
    const foreign = await req('POST', '/expenses', {
        ...expensePayload('Charged to another store', 10),
        expenseAccountId: FOREIGN_ACC,
    }, staff);
    check("cannot charge another store's account", foreign.status === 400, `status ${foreign.status}`);

    const wrongType = await req('POST', '/expenses', {
        ...expensePayload('Charged to revenue', 10),
        expenseAccountId: REVENUE_ACC,
    }, staff);
    check('cannot charge a non-expense account', wrongType.status === 400, `status ${wrongType.status}`);

    const notPayable = await req('POST', '/expenses', {
        ...expensePayload('Paid from inventory', 10),
        paymentAccountId: STOCK_ACC,
    }, staff);
    check('cannot pay from an account that is not a payment method', notPayable.status === 400, `status ${notPayable.status}`);

    const negative = await req('POST', '/expenses', expensePayload('Negative', -5), staff);
    check('cannot record a negative amount', negative.status === 400, `status ${negative.status}`);

    const renamed = await req('POST', '/expenses', {
        ...expensePayload('Relabelled account', 12),
        expenseAccountName: 'Totally Different Label',
    }, staff);
    check(
        'the account name comes from the ledger, not the request',
        renamed.status === 201 && renamed.data?.expenseAccountName === 'Test Transport',
        renamed.data?.expenseAccountName,
    );

    // 7. Admin sees the whole store.
    const adminList = await req('GET', '/expenses', null, admin);
    check(
        'admin sees every expense in the store',
        (adminList.data?.items ?? []).length === 4,
        `${(adminList.data?.items ?? []).length} item(s)`,
    );
    const adminEdit = await req('PUT', `/expenses/${expenseId}`, expensePayload('Corrected by owner', 50), admin);
    check('admin can still edit', adminEdit.status === 200, `status ${adminEdit.status}`);
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
