import db from '../db_client';
import { storeInitService } from '../services/store-init.service';

async function verify() {
    const testStoreId = 'test_h_' + Math.random().toString(36).slice(2, 8);
    const testStoreName = 'Hierarchy Test Store';

    try {
        console.log(`--- Verifying Hierarchy for ${testStoreId} ---`);

        await db.query("INSERT INTO stores (id, name, status, subscription_status) VALUES ($1, $2, 'active', 'active')", [testStoreId, testStoreName]);
        await storeInitService.initializeNewStore(testStoreId, testStoreName);

        // Verify Categories
        const categoriesRes = await db.query('SELECT id, name, parent_id FROM categories WHERE store_id = $1', [testStoreId]);
        const categories = categoriesRes.rows;
        console.log(`Total Categories Created: ${categories.length}`);

        const topLevel = categories.filter(c => c.parent_id === null);
        const children = categories.filter(c => c.parent_id !== null);

        console.log(`Top Level Categories: ${topLevel.length}`);
        console.log(`Sub-Categories: ${children.length}`);

        if (topLevel.length > 0 && children.length > 0) {
            console.log('✅ Hierarchy Verified (Found both parents and children)');

            // Check specific nesting (e.g., Food & Beverages -> Food (Prepared & Packaged))
            const foodParent = topLevel.find(c => c.name === 'Food & Beverages');
            if (foodParent) {
                const subCat = children.find(c => c.parent_id === foodParent.id && c.name === 'Food (Prepared & Packaged)');
                if (subCat) {
                    console.log('✅ Specific nesting verified: Food & Beverages -> Food (Prepared & Packaged)');

                    const leafCat = children.find(c => c.parent_id === subCat.id && c.name === 'Fast Food');
                    if (leafCat) {
                        console.log('✅ Deep nesting verified: ... -> Food (Prepared & Packaged) -> Fast Food');
                    } else {
                        console.error('❌ Deep nesting failed: Fast Food not found under subCat');
                    }
                } else {
                    console.error('❌ Sub-category not found under Food & Beverages');
                }
            } else {
                console.error('❌ Food & Beverages parent not found');
            }
        } else {
            console.error('❌ Hierarchy Verification Failed (Missing children or parents)');
        }

    } catch (error) {
        console.error('❌ Verification Error:', error);
    } finally {
        process.exit(0);
    }
}

verify();
