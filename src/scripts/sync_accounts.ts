import db from '../db_client';
import { toCamelCase } from '../utils/helpers';

async function syncAccounts() {
    console.log('Starting accounting synchronization audit...');

    const client = await (db as any)._pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Sync Customer Balances (Sub-ledger)
        console.log('Syncing customer balances...');
        const customersResult = await client.query('SELECT id, name, store_id FROM customers');
        const customers = customersResult.rows;

        for (const customer of customers) {
            // Calculate what balance SHOULD be:
            // SUM(unpaid/partially paid sales total) - SUM(payments for those sales)
            // Actually, simpler: SUM(all sales total for customer) - SUM(all payments for customer sales) - SUM(all refunds to account for customer)

            const salesTotalRes = await client.query(
                'SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE customer_id = $1 AND store_id = $2 AND fulfillment_status != \'cancelled\'',
                [customer.id, customer.store_id]
            );
            const paymentsTotalRes = await client.query(
                'SELECT COALESCE(SUM(p.amount), 0) as total FROM payments p JOIN sales s ON p.sale_id = s.transaction_id WHERE s.customer_id = $1 AND s.store_id = $2',
                [customer.id, customer.store_id]
            );
            const returnsTotalRes = await client.query(
                'SELECT COALESCE(SUM(r.refund_amount), 0) as total FROM returns r JOIN sales s ON r.original_sale_id = s.transaction_id WHERE s.customer_id = $1 AND s.store_id = $2 AND (r.refund_method = \'accounts_receivable\' OR r.refund_method = \'on_account\')',
                [customer.id, customer.store_id]
            );

            const calculatedBalance = Number(salesTotalRes.rows[0].total) - Number(paymentsTotalRes.rows[0].total) - Number(returnsTotalRes.rows[0].total);

            await client.query(
                'UPDATE customers SET account_balance = $1 WHERE id = $2 AND store_id = $3',
                [calculatedBalance, customer.id, customer.store_id]
            );

            if (Math.abs(calculatedBalance) > 0.001) {
                console.log(`Updated ${customer.name} balance to ${calculatedBalance.toFixed(2)}`);
            }
        }

        // 2. Sync GL Accounts (Balances)
        console.log('Syncing GL account balances from journal entries...');
        const accountsResult = await client.query('SELECT id, is_debit_normal, store_id, name FROM accounts');
        const accounts = accountsResult.rows;

        for (const account of accounts) {
            const linesResult = await client.query(
                'SELECT type, SUM(amount) as total FROM journal_entry_lines WHERE account_id = $1 AND store_id = $2 GROUP BY type',
                [account.id, account.store_id]
            );

            let debits = 0;
            let credits = 0;

            linesResult.rows.forEach((row: any) => {
                if (row.type === 'debit') debits = Number(row.total);
                if (row.type === 'credit') credits = Number(row.total);
            });

            let newBalance = account.is_debit_normal ? (debits - credits) : (credits - debits);

            await client.query(
                'UPDATE accounts SET balance = $1 WHERE id = $2 AND store_id = $3',
                [newBalance, account.id, account.store_id]
            );
        }

        await client.query('COMMIT');
        console.log('Synchronization complete.');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Synchronization failed:', error);
    } finally {
        client.release();
    }
}

syncAccounts().then(() => process.exit(0));
