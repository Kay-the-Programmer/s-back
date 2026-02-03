import db from '../db_client';

async function checkMetrics() {
    const storeIdResult = await db.query('SELECT id FROM stores LIMIT 1');
    if (storeIdResult.rowCount === 0) {
        console.log('No stores found');
        return;
    }
    const storeId = storeIdResult.rows[0].id;
    console.log(`Checking metrics for store: ${storeId}`);

    const arQuery = `SELECT COALESCE(SUM(account_balance), 0) as "accountsReceivable" FROM customers WHERE store_id = $1`;
    const glQuery = `SELECT COALESCE(SUM(balance), 0) as balance FROM accounts WHERE store_id = $1 AND sub_type = 'accounts_receivable'`;

    const [arRes, glRes] = await Promise.all([
        db.query(arQuery, [storeId]),
        db.query(glQuery, [storeId])
    ]);

    const arSubledger = parseFloat(arRes.rows[0].accountsReceivable);
    const arGL = parseFloat(glRes.rows[0].balance);

    console.log(`Accounts Receivable (Sub-ledger): ${arSubledger}`);
    console.log(`Accounts Receivable (GL): ${arGL}`);
    console.log(`Match: ${Math.abs(arSubledger - arGL) < 0.01}`);
}

checkMetrics().then(() => process.exit(0));
