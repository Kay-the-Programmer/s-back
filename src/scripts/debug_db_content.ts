
import db from '../db_client';

async function listData() {
    try {
        console.log("Listing Stores...");
        const stores = await db.query('SELECT id, name FROM stores LIMIT 5');
        console.log("Stores:", stores.rows);

        if (stores.rows.length > 0) {
            const storeId = stores.rows[0].id;
            console.log(`Listing Products for store ${storeId}...`);
            const products = await db.query('SELECT id, name, price, stock FROM products WHERE store_id = $1 LIMIT 5', [storeId]);
            console.log("Products:", products.rows);
        }
    } catch (e) {
        console.error("Error:", e);
    } finally {
        process.exit();
    }
}

listData();
