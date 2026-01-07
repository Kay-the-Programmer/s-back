
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function runMigration() {
    try {
        console.log('Running manual migration...');

        // Add fulfillment_status
        try {
            await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS fulfillment_status TEXT CHECK (fulfillment_status IN ('pending','fulfilled','shipped','cancelled'));`);
            console.log('Added fulfillment_status column.');
        } catch (e: any) { console.log('fulfillment_status error:', e.message); }

        // Add channel
        try {
            await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS channel TEXT CHECK (channel IN ('pos','online'));`);
            console.log('Added channel column.');
        } catch (e: any) { console.log('channel error:', e.message); }

        // Add customer_details
        try {
            await pool.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_details JSONB;`);
            console.log('Added customer_details column.');
        } catch (e: any) { console.log('customer_details error:', e.message); }

        // Set Defaults
        await pool.query(`ALTER TABLE sales ALTER COLUMN fulfillment_status SET DEFAULT 'fulfilled';`);
        await pool.query(`ALTER TABLE sales ALTER COLUMN channel SET DEFAULT 'pos';`);
        await pool.query(`UPDATE sales SET fulfillment_status = 'fulfilled' WHERE fulfillment_status IS NULL;`);
        await pool.query(`UPDATE sales SET channel = 'pos' WHERE channel IS NULL;`);

        console.log('Migration completed.');
    } catch (err) {
        console.error('Migration failed:', err);
    } finally {
        await pool.end();
    }
}

runMigration();
