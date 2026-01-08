
import db from '../db_client';

async function checkSchema() {
    try {
        console.log("Checking payments table schema...");
        const result = await db.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'payments'
        `);
        console.log("Columns in 'payments' table:");
        result.rows.forEach(col => {
            console.log(`- ${col.column_name}: ${col.data_type}`);
        });

        console.log("\nChecking sales table schema...");
        const salesResult = await db.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'sales'
        `);
        console.log("Columns in 'sales' table:");
        salesResult.rows.forEach(col => {
            console.log(`- ${col.column_name}: ${col.data_type}`);
        });

    } catch (e) {
        console.error("Error:", e);
    } finally {
        process.exit();
    }
}

checkSchema();
