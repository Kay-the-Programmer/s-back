
import db from './src/db_client';

async function checkTables() {
    const client = await (db as any)._pool.connect();
    try {
        const res = await client.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name IN ('couriers', 'shipments');
        `);
        console.log('Found tables:', res.rows.map((r: any) => r.table_name));
    } catch (err) {
        console.error(err);
    } finally {
        client.release();
        process.exit(0);
    }
}

checkTables();
