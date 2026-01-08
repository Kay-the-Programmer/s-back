
import db from '../db_client';

async function inspectSale(transactionId: string) {
    try {
        console.log(`Inspecting Sale: ${transactionId}`);
        const saleResult = await db.query('SELECT * FROM sales WHERE transaction_id = $1', [transactionId]);
        if (saleResult.rowCount === 0) {
            console.log("Sale not found.");
            return;
        }
        const sale = saleResult.rows[0];
        console.log("Sale data:", sale);

        const storeId = sale.store_id;
        console.log(`Store ID: ${storeId}`);

        console.log("\nChecking related payments...");
        const paymentsResult = await db.query('SELECT * FROM payments WHERE sale_id = $1', [transactionId]);
        console.log("Payments:", paymentsResult.rows);

        console.log("\nChecking store accounts...");
        const accountsResult = await db.query('SELECT id, name, number, sub_type FROM accounts WHERE store_id = $1', [storeId]);
        console.log("Accounts found for store:", accountsResult.rows);

        const cashAcc = accountsResult.rows.find(a => a.sub_type === 'cash');
        const arAcc = accountsResult.rows.find(a => a.sub_type === 'accounts_receivable');
        console.log(`Cash Account: ${cashAcc ? 'Found' : 'MISSING'}`);
        console.log(`AR Account: ${arAcc ? 'Found' : 'MISSING'}`);

    } catch (e) {
        console.error("Error during inspection:", e);
    } finally {
        process.exit();
    }
}

const id = process.argv[2] || 'ord_q0axs8pq2';
inspectSale(id);
