
import db from './src/db_client';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config();

async function verify() {
    let output = 'Verifying constraints...\n';
    try {
        const result_constraints = await db.query(`
            SELECT conname, contype 
            FROM pg_constraint 
            WHERE conrelid = 'products'::regclass 
            AND conname IN ('products_sku_key', 'products_barcode_key');
        `);

        output += 'Old Constraints (should be empty): ' + JSON.stringify(result_constraints.rows) + '\n';

        const result_indexes = await db.query(`
            SELECT indexname, indexdef 
            FROM pg_indexes 
            WHERE tablename = 'products' 
            AND indexname IN ('uidx_products_store_sku', 'uidx_products_store_barcode');
        `);

        output += 'New Indexes (should exist): ' + JSON.stringify(result_indexes.rows) + '\n';
        fs.writeFileSync('verification_output.txt', output);
        process.exit(0);
    } catch (e) {
        fs.writeFileSync('verification_output.txt', 'Error: ' + e);
        process.exit(1);
    }
}

verify();
