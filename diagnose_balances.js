const { Pool } = require('pg');
const pool = new Pool({
    connectionString: 'postgresql://postgres:password@localhost:5432/salepilot'
});

async function run() {
    try {
        console.log('--- START DIAGNOSTICS ---');

        const accounts = await pool.query('SELECT name, number, sub_type, balance, is_debit_normal FROM accounts ORDER BY number');
        console.log('ACCOUNTS:');
        console.table(accounts.rows);

        const settings = await pool.query('SELECT * FROM store_settings');
        console.log('SETTINGS:');
        console.table(settings.rows);

        const lastEntries = await pool.query(`
            SELECT je.date, je.description, jel.account_name, jel.type, jel.amount
            FROM journal_entries je
            JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
            ORDER BY je.date DESC
            LIMIT 20
        `);
        console.log('LAST 20 JOURNAL LINES:');
        console.table(lastEntries.rows);

        console.log('--- END DIAGNOSTICS ---');
    } catch (err) {
        console.error('ERROR:', err);
    } finally {
        await pool.end();
    }
}

run();
