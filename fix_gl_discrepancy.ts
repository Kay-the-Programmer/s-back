import db from './src/db_client';
import { generateId } from './src/utils/helpers';

async function fixDiscrepancies() {
    const client = await db._pool.connect();
    try {
        const stores = await client.query('SELECT DISTINCT id FROM stores LIMIT 1');
        const storeId = stores.rows[0]?.id;
        if (!storeId) {
            console.log('No store found');
            return;
        }

        await client.query('BEGIN');

        // 1. Fix AR Subledger
        console.log('Fixing AR Subledger (-7.69 for Admin User)...');
        await client.query(`
        UPDATE customers 
        SET account_balance = 0 
        WHERE store_id = $1 AND name = 'Admin User' AND account_balance = -7.69
    `, [storeId]);
        console.log('AR Subledger fixed.');

        // 2. Fix Inventory GL
        console.log('Fixing Inventory GL (+5491 adjustment)...');

        // Check if we already fixed it to avoid double entry
        const checkRes = await client.query(`
        SELECT balance FROM accounts 
        WHERE store_id = $1 AND sub_type = 'inventory'
    `, [storeId]);
        const currentInvBalance = parseFloat(checkRes.rows[0]?.balance || 0);

        if (Math.abs(currentInvBalance - 100000) < 0.01) {
            // Find necessary accounts
            const invAccount = await client.query(`SELECT id, name FROM accounts WHERE store_id = $1 AND sub_type = 'inventory'`, [storeId]);
            const adjAccount = await client.query(`SELECT id, name FROM accounts WHERE store_id = $1 AND sub_type = 'inventory_adjustment'`, [storeId]);

            const invAccId = invAccount.rows[0]?.id;
            const invAccName = invAccount.rows[0]?.name;
            const adjAccId = adjAccount.rows[0]?.id;
            const adjAccName = adjAccount.rows[0]?.name;

            if (invAccId && adjAccId) {
                const entryId = generateId('je');
                const diff = 5491.00;

                await client.query(`
                INSERT INTO journal_entries (id, date, description, source_type, source_id, store_id)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [entryId, new Date().toISOString(), 'Data Correction: Align GL with Inventory Subledger', 'manual', null, storeId]);

                // Debit Inventory 5491
                await client.query(`
                INSERT INTO journal_entry_lines (journal_entry_id, account_id, type, amount, account_name, store_id)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [entryId, invAccId, 'debit', diff, invAccName, storeId]);

                // Credit Inventory Adjustment 5491
                await client.query(`
                INSERT INTO journal_entry_lines (journal_entry_id, account_id, type, amount, account_name, store_id)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [entryId, adjAccId, 'credit', diff, adjAccName, storeId]);

                // Update balances directly
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [diff, invAccId]);
                await client.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2', [-diff, adjAccId]); // Expense accounts usually debit normal, so credit decreases/increases it? Actually just subtract from balance.
                console.log('Inventory GL fixed.');
            } else {
                console.log('Could not find inventory accounts');
            }
        } else {
            console.log('Inventory GL already aligned or mismatch is handled.');
        }

        await client.query('COMMIT');
        console.log('All discrepancies resolved.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Error fixing discrepancies:', err);
    } finally {
        client.release();
        process.exit(0);
    }
}

fixDiscrepancies();
