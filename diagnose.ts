import db from './src/db_client';
import fs from 'fs';

async function diagnose() {
    const stores = await db.query('SELECT DISTINCT id FROM stores LIMIT 1');
    const actualStoreId = stores.rows[0]?.id;

    const inventoryQuery = `SELECT COALESCE(SUM(cost_price * stock), 0) as "inventoryValue" FROM products WHERE store_id = $1 AND status = 'active'`;
    const arQuery = `SELECT COALESCE(SUM(account_balance), 0) as "accountsReceivable" FROM customers WHERE store_id = $1`;
    const apQuery = `SELECT COALESCE(SUM(amount - amount_paid), 0) as "accountsPayable" FROM supplier_invoices WHERE store_id = $1`;
    const storeCreditQuery = `SELECT COALESCE(SUM(store_credit), 0) as "storeCreditValue" FROM customers WHERE store_id = $1`;

    const glBalancesQuery = `
      SELECT 
          type,
          sub_type as "subType",
          COALESCE(SUM(balance), 0) as balance
      FROM accounts 
      WHERE store_id = $1 
      GROUP BY type, sub_type
  `;

    const [invResult, arResult, apResult, scResult, glResult] = await Promise.all([
        db.query(inventoryQuery, [actualStoreId]),
        db.query(arQuery, [actualStoreId]),
        db.query(apQuery, [actualStoreId]),
        db.query(storeCreditQuery, [actualStoreId]),
        db.query(glBalancesQuery, [actualStoreId])
    ]);

    const inventoryValue = parseFloat(invResult.rows[0].inventoryValue);
    const accountsReceivable = parseFloat(arResult.rows[0].accountsReceivable);
    const accountsPayable = parseFloat(apResult.rows[0].accountsPayable);
    const storeCreditValue = parseFloat(scResult.rows[0].storeCreditValue);

    const glBalances = glResult.rows.map((r: any) => ({ ...r, balance: parseFloat(r.balance) }));

    const arGL = glBalances.find((b: any) => b.subType === 'accounts_receivable')?.balance || 0;
    const apGL = glBalances.find((b: any) => b.subType === 'accounts_payable')?.balance || 0;
    const invGL = glBalances.find((b: any) => b.subType === 'inventory')?.balance || 0;
    const scGL = glBalances.find((b: any) => b.subType === 'store_credit_payable')?.balance || 0;

    const results = {
        storeId: actualStoreId,
        ar: { subledger: accountsReceivable, gl: arGL, diff: accountsReceivable - arGL, match: Math.abs(accountsReceivable - arGL) < 0.01 },
        ap: { subledger: accountsPayable, gl: apGL, diff: accountsPayable - apGL, match: Math.abs(accountsPayable - apGL) < 0.01 },
        inventory: { subledger: inventoryValue, gl: invGL, diff: inventoryValue - invGL, match: Math.abs(inventoryValue - invGL) < 0.01 },
        storeCredit: { subledger: storeCreditValue, gl: scGL, diff: storeCreditValue - Math.abs(scGL), match: Math.abs(storeCreditValue - Math.abs(scGL)) < 0.01 }
    };

    fs.writeFileSync('diagnose-result.json', JSON.stringify(results, null, 2));
    process.exit(0);
}

diagnose().catch(err => {
    fs.writeFileSync('diagnose-result.json', JSON.stringify({ error: err.toString() }));
    process.exit(1);
});
