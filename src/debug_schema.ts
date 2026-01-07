
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function checkSchema() {
    try {
        console.log('Checking sales table schema...');
        const res = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'sales'
        `);

        console.log('Columns in sales table:');
        res.rows.forEach(row => {
            console.log(`- ${row.column_name} (${row.data_type})`);
        });

        const missing = ['fulfillment_status', 'channel', 'customer_details'].filter(
            col => !res.rows.some(r => r.column_name === col)
        );

        if (missing.length > 0) {
            console.error('❌ MISSING COLUMNS:', missing);
        } else {
            console.log('✅ All required columns present.');
        }

    } catch (err) {
        console.error('Error checking schema:', err);
    } finally {
        await pool.end();
    }
}

checkSchema();
