import db from './src/db_client';
import fs from 'fs';

async function diagnose() {
    const stores = await db.query('SELECT DISTINCT id FROM stores LIMIT 1');
    const storeId = stores.rows[0]?.id;

    const inventoryAccountRes = await db.query(`SELECT id, balance FROM accounts WHERE store_id = $1 AND sub_type = 'inventory'`, [storeId]);
    const arAccountRes = await db.query(`SELECT id, balance FROM accounts WHERE store_id = $1 AND sub_type = 'accounts_receivable'`, [storeId]);

    const invAccId = inventoryAccountRes.rows[0]?.id;
    const arAccId = arAccountRes.rows[0]?.id;

    const invJeRes = await db.query(`
    SELECT type, SUM(amount) as total 
    FROM journal_entry_lines 
    WHERE account_id = $1 
    GROUP BY type
  `, [invAccId]);

    const arJeRes = await db.query(`
    SELECT type, SUM(amount) as total 
    FROM journal_entry_lines 
    WHERE account_id = $1 
    GROUP BY type
  `, [arAccId]);

    const recentProductsRes = await db.query(`
    SELECT id, name, stock, cost_price, (stock * cost_price) as total_value
    FROM products 
    WHERE store_id = $1 
    LIMIT 10
  `, [storeId]);

    const recentCustomersRes = await db.query(`
    SELECT id, name, account_balance
    FROM customers
    WHERE store_id = $1 AND account_balance != 0
  `, [storeId]);

    const results = {
        inventory_account: inventoryAccountRes.rows[0],
        ar_account: arAccountRes.rows[0],
        inv_je_summary: invJeRes.rows,
        ar_je_summary: arJeRes.rows,
        recent_products: recentProductsRes.rows,
        customers_with_balance: recentCustomersRes.rows
    };

    fs.writeFileSync('diagnose-details.json', JSON.stringify(results, null, 2));
    process.exit(0);
}

diagnose().catch(err => console.error(err));
