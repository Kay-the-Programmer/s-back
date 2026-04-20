import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

async function runMigration() {
    try {
        console.log('Running carton fields migration...');

        // Add carton_price - the total cost of one carton/box
        try {
            await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS carton_price NUMERIC(12,4) DEFAULT NULL;`);
            console.log('✅ Added carton_price column.');
        } catch (e: any) { console.log('carton_price error:', e.message); }

        // Add units_per_carton - number of sellable units inside one carton
        try {
            await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_carton INTEGER DEFAULT NULL;`);
            console.log('✅ Added units_per_carton column.');
        } catch (e: any) { console.log('units_per_carton error:', e.message); }

        // Add cartons_received - total number of cartons received (for reference)
        try {
            await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS cartons_received INTEGER DEFAULT NULL;`);
            console.log('✅ Added cartons_received column.');
        } catch (e: any) { console.log('cartons_received error:', e.message); }

        console.log('✅ Carton fields migration completed successfully.');
    } catch (err) {
        console.error('❌ Migration failed:', err);
    } finally {
        await pool.end();
    }
}

runMigration();
