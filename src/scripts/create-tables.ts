// create-tables.ts
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Database connection configuration
const pool = new Pool({
    user: 'postgres',      // Default PostgreSQL user, change if needed
    host: 'localhost',     // Default PostgreSQL host, change if needed
    database: 'sale_pilot_db',
    password: 'password',  // Change to your PostgreSQL password
    port: 5432,            // Default PostgreSQL port, change if needed
});

async function createTables() {
    const client = await pool.connect();

    try {
        console.log('Connected to PostgreSQL database');

        // Read the SQL file
        const sqlFilePath = path.join(__dirname, '..', 'sql');
        const sqlContent = fs.readFileSync(sqlFilePath, 'utf8');

        console.log('Executing SQL statements to create tables...');

        // Execute the SQL statements
        await client.query(sqlContent);

        console.log('All tables have been created successfully!');
    } catch (error) {
        console.error('Error creating tables:', error);
    } finally {
        // Release the client back to the pool
        client.release();
        // Close the pool
        await pool.end();
    }
}

// Run the function
createTables().catch(console.error);