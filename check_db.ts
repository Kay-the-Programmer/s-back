import db from './src/db_client';

async function check() {
    try {
        const res = await db.query('SELECT store_id, lenco_public_key, lenco_secret_key FROM store_settings');
        console.log(res.rows);
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}

check();
