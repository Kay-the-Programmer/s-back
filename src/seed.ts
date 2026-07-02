import db from './db_client';
import bcrypt from 'bcryptjs';
import { generateId } from './utils/helpers';
import { Pool } from 'pg';
import { StoreSettings, Account, Supplier, Category, Product } from './types';
import { categoryHierarchy, initialAccountsData } from './utils/initial-data';

// --- Seed Data ---

const defaultSettings: StoreSettings = {
    name: 'SalePilot Gourmet Market',
    address: '456 Commerce Ave, San Francisco, CA 94103',
    phone: '(123) 555-1234',
    email: 'hello@spgourmet.com',
    website: 'https://spgourmet.com',
    taxRate: 8.5,
    currency: { symbol: '$', code: 'USD', position: 'before' },
    receiptMessage: 'Thank you for shopping with us!',
    lowStockThreshold: 15,
    skuPrefix: 'SPGM-',
    enableStoreCredit: true,
    paymentMethods: [
        { id: 'cash', name: 'CASH' },
        { id: 'airtel', name: 'AIRTEL' },
        { id: 'mtn', name: 'MTN' }
    ],
    supplierPaymentMethods: [
        { id: 'cash', name: 'CASH' },
        { id: 'airtel', name: 'AIRTEL' },
        { id: 'mtn', name: 'MTN' }
    ]
};

const initialAccounts = initialAccountsData;

const initialSuppliers: Omit<Supplier, 'id'>[] = [
    { name: 'World Coffee Importers', contactPerson: 'John Bean', email: 'sales@wcoffee.com', paymentTerms: 'Net 30' },
    { name: 'Green Leaf Teas', contactPerson: 'Jane Steep', email: 'contact@greenleaf.com', paymentTerms: 'Net 15' },
    { name: 'Local Mill & Co.', contactPerson: 'Bob Miller', email: 'orders@localmill.com', paymentTerms: 'COD' },
    { name: 'Fresh Farms Produce', contactPerson: 'Alice Green', email: 'orders@freshfarms.com', paymentTerms: 'Net 7' },
    { name: 'Dairy Delight', contactPerson: 'Charlie Moo', email: 'sales@dairydelight.com', paymentTerms: 'Net 15' },
    { name: 'Ocean Harvest', contactPerson: 'Sam Fisher', email: 'info@oceanharvest.com', paymentTerms: 'Net 30' },
    { name: 'Pantry Essentials', contactPerson: 'Dave Stock', email: 'wholesale@pantry.com', paymentTerms: 'Net 30' },
    { name: 'Meat & Poultry Co.', contactPerson: 'Sarah Butcher', email: 'orders@meatco.com', paymentTerms: 'Net 15' },
    { name: 'Snack Haven', contactPerson: 'Tom Munch', email: 'hello@snackhaven.com', paymentTerms: 'COD' },
];

const initialCategories = categoryHierarchy;

// --- Seeding Functions ---

async function seedAdminUser(client: any) {
    // Dev convenience account with a hardcoded password — never seed in production.
    if (process.env.NODE_ENV === 'production') {
        console.log('Skipping default admin seed (production).');
        return;
    }
    const adminEmail = 'admin@sale-pilot.com';
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (existing.rowCount > 0) {
        console.log('Admin user already exists.');
        return;
    }
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash('password', salt);
    await client.query(
        'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
        [generateId('user'), 'Admin User', adminEmail, passwordHash, 'admin']
    );
    console.log('✅ Admin user created (admin@sale-pilot.com / password)');
}

async function seedSettings(client: any) {
    // Try to find a store context to seed. Prefer a user's current_store_id.
    const storeRes = await client.query('SELECT current_store_id AS store_id FROM users WHERE current_store_id IS NOT NULL LIMIT 1');
    const storeId: string | null = storeRes.rows?.[0]?.store_id || null;
    if (!storeId) {
        console.log('ℹ️ No store_id found to seed store_settings; skipping.');
        return;
    }
    const query = `
        INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (store_id) DO NOTHING;
    `;
    await client.query(query, [
        storeId,
        defaultSettings.name, defaultSettings.address, defaultSettings.phone, defaultSettings.email, defaultSettings.website,
        defaultSettings.taxRate, JSON.stringify(defaultSettings.currency), defaultSettings.receiptMessage, defaultSettings.lowStockThreshold,
        defaultSettings.skuPrefix, defaultSettings.enableStoreCredit, JSON.stringify(defaultSettings.paymentMethods), JSON.stringify(defaultSettings.supplierPaymentMethods)
    ]);
    console.log('✅ Default store settings seeded for store:', storeId);
}

async function seedAccounts(client: any) {
    // Prefer a specific store context. If none available, skip (runtime will auto-create per store).
    const storeRes = await client.query('SELECT current_store_id AS store_id FROM users WHERE current_store_id IS NOT NULL LIMIT 1');
    const storeId: string | null = storeRes.rows?.[0]?.store_id || null;
    if (!storeId) {
        console.log('ℹ️ No store_id found to seed accounts; runtime will auto-create when needed.');
        return;
    }
    for (const acc of initialAccounts) {
        await client.query(
            'INSERT INTO accounts (id, name, number, type, sub_type, is_debit_normal, description, balance, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) ON CONFLICT (store_id, number) DO NOTHING',
            [generateId('acc'), acc.name, acc.number, acc.type, acc.subType, acc.isDebitNormal, acc.description, storeId]
        );
    }
    console.log('✅ Chart of Accounts seeded for store:', storeId);
}

async function seedInitialData(client: any) {
    const storeRes = await client.query('SELECT current_store_id AS store_id FROM users WHERE current_store_id IS NOT NULL LIMIT 1');
    const storeId: string | null = storeRes.rows?.[0]?.store_id || null;

    if (!storeId) {
        console.log('ℹ️ No store_id found to seed initial data; skipping products/suppliers/categories.');
        return;
    }

    const supplierMap = new Map<string, string>();
    for (const sup of initialSuppliers) {
        let res = await client.query('SELECT id FROM suppliers WHERE name = $1 AND store_id = $2', [sup.name, storeId]);
        if (res.rowCount === 0) {
            res = await client.query('INSERT INTO suppliers (id, name, contact_person, email, payment_terms, store_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id', [generateId('sup'), sup.name, sup.contactPerson, sup.email, sup.paymentTerms, storeId]);
        }
        if (res.rows[0]) supplierMap.set(sup.name, res.rows[0].id);
    }

    const categoryMap = new Map<string, string>();
    const insertCategoryRecursive = async (cat: any, parentId: string | null) => {
        const name = typeof cat === 'string' ? cat : cat.name;
        let res = await client.query('SELECT id FROM categories WHERE name = $1 AND (parent_id = $2 OR (parent_id IS NULL AND $2 IS NULL)) AND store_id = $3', [name, parentId, storeId]);
        let id: string;
        if (res.rowCount === 0) {
            id = generateId('cat');
            res = await client.query('INSERT INTO categories (id, name, parent_id, attributes, store_id) VALUES ($1, $2, $3, $4, $5) RETURNING id', [id, name, parentId, '[]', storeId]);
            id = res.rows[0].id;
        } else {
            id = res.rows[0].id;
        }
        categoryMap.set(name, id);

        if (cat.children && Array.isArray(cat.children)) {
            for (const child of cat.children) {
                await insertCategoryRecursive(child, id);
            }
        }
    };

    for (const cat of initialCategories) {
        await insertCategoryRecursive(cat, null);
    }
    console.log('✅ Initial suppliers & categories seeded.');

    // --- Seed Products ---

    const initialProducts: Omit<Product, 'id'>[] = [
        // Beverages
        { name: 'Premium Blend Coffee', description: 'A rich, full-bodied blend of Arabica beans from South America.', sku: 'SP-84321', barcode: '888000011122', categoryId: categoryMap.get('Beverages'), price: 18.99, costPrice: 12.50, stock: 50, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('World Coffee Importers'), brand: 'Global Roast', status: 'active' },
        { name: 'Organic Green Tea', description: 'Delicate and refreshing green tea, sourced from the finest gardens.', sku: 'SP-19874', barcode: '888000011133', categoryId: categoryMap.get('Beverages'), price: 12.49, costPrice: 8.00, stock: 75, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Green Leaf Teas'), brand: 'Zen Garden', status: 'active' },
        { name: 'Sparkling Mineral Water', description: 'Naturally carbonated mineral water from the Alps.', sku: 'SP-12001', barcode: '888000022001', categoryId: categoryMap.get('Beverages'), price: 2.99, costPrice: 1.20, stock: 120, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Pantry Essentials'), status: 'active' },

        // Bakery
        { name: 'Artisan Sourdough Bread', description: 'Naturally leavened sourdough with a crispy crust and chewy interior.', sku: 'SP-33215', barcode: '888000011144', categoryId: categoryMap.get('Bakery'), price: 6.99, costPrice: 3.50, stock: 25, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Local Mill & Co.'), brand: 'The Bakehouse', status: 'active' },
        { name: 'Butter Croissants (4-pack)', description: 'Flaky, buttery croissants made with premium French butter.', sku: 'SP-33216', barcode: '888000011155', categoryId: categoryMap.get('Bakery'), price: 8.50, costPrice: 4.00, stock: 30, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Local Mill & Co.'), brand: 'The Bakehouse', status: 'active' },

        // Produce
        { name: 'Honeycrisp Apples (3lb)', description: 'Sweet, crisp, and juicy Honeycrisp apples.', sku: 'SP-44001', barcode: '888000044001', categoryId: categoryMap.get('Produce'), price: 6.49, costPrice: 3.20, stock: 40, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Fresh Farms Produce'), status: 'active' },
        { name: 'Organic Baby Spinach', description: 'Pre-washed baby spinach leaves.', sku: 'SP-44002', barcode: '888000044002', categoryId: categoryMap.get('Produce'), price: 4.99, costPrice: 2.10, stock: 60, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Fresh Farms Produce'), status: 'active' },
        { name: 'Vine-Ripened Tomatoes', description: 'Farm-fresh tomatoes on the vine.', sku: 'SP-44003', barcode: '888000044003', categoryId: categoryMap.get('Produce'), price: 3.99, costPrice: 1.80, stock: 50, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Fresh Farms Produce'), status: 'active' },

        // Dairy & Eggs
        { name: 'Whole Milk (1 Gallon)', description: 'Fresh, pasteurized whole milk.', sku: 'SP-55001', barcode: '888000055001', categoryId: categoryMap.get('Dairy & Eggs'), price: 4.29, costPrice: 2.50, stock: 45, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Dairy Delight'), status: 'active' },
        { name: 'Large Grade A Eggs (Dozen)', description: 'Farm-fresh large white eggs.', sku: 'SP-55002', barcode: '888000055002', categoryId: categoryMap.get('Dairy & Eggs'), price: 3.49, costPrice: 1.90, stock: 80, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Dairy Delight'), status: 'active' },
        { name: 'Greek Yogurt (Plain)', description: 'Creamy high-protein plain Greek yogurt.', sku: 'SP-55003', barcode: '888000055003', categoryId: categoryMap.get('Dairy & Eggs'), price: 5.99, costPrice: 3.10, stock: 35, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Dairy Delight'), status: 'active' },

        // Meat & Seafood
        { name: 'Ribeye Steak (Twin Pack)', description: 'Premium marbled ribeye steaks.', sku: 'SP-66001', barcode: '888000066001', categoryId: categoryMap.get('Meat & Seafood'), price: 24.99, costPrice: 15.00, stock: 15, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Meat & Poultry Co.'), status: 'active' },
        { name: 'Fresh Atlantic Salmon Fillet', description: 'Sustainably farmed Atlantic salmon.', sku: 'SP-66002', barcode: '888000066002', categoryId: categoryMap.get('Meat & Seafood'), price: 15.99, costPrice: 9.50, stock: 20, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Ocean Harvest'), status: 'active' },
        { name: 'Chicken Breasts (Boneless)', description: 'Lean, skinless chicken breasts.', sku: 'SP-66003', barcode: '888000066003', categoryId: categoryMap.get('Meat & Seafood'), price: 12.49, costPrice: 7.20, stock: 30, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Meat & Poultry Co.'), status: 'active' },

        // Pantry
        { name: 'Extra Virgin Olive Oil', description: 'Cold-pressed extra virgin olive oil from Spain.', sku: 'SP-77001', barcode: '888000077001', categoryId: categoryMap.get('Pantry'), price: 14.99, costPrice: 8.00, stock: 40, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Pantry Essentials'), status: 'active' },
        { name: 'Sea Salt', description: 'Fine grain natural sea salt.', sku: 'SP-77002', barcode: '888000077002', categoryId: categoryMap.get('Pantry'), price: 3.49, costPrice: 1.20, stock: 100, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Pantry Essentials'), status: 'active' },
        { name: 'Organic Quinoa', description: 'Tri-color organic quinoa.', sku: 'SP-77003', barcode: '888000077003', categoryId: categoryMap.get('Pantry'), price: 8.99, costPrice: 4.50, stock: 50, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Pantry Essentials'), status: 'active' },

        // Snacks
        { name: 'Gourmet Chocolate Bar', description: '70% dark chocolate with hints of sea salt.', sku: 'SP-54321', barcode: '888000054321', categoryId: categoryMap.get('Snacks'), price: 5.99, costPrice: 2.50, stock: 100, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Snack Haven'), status: 'active' },
        { name: 'Roasted Almonds (Salted)', description: 'Premium roasted almonds with a touch of sea salt.', sku: 'SP-88001', barcode: '888000088001', categoryId: categoryMap.get('Snacks'), price: 9.49, costPrice: 5.00, stock: 60, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Snack Haven'), status: 'active' },
        { name: 'Potato Chips (Classic)', description: 'Kettle-cooked classic salted potato chips.', sku: 'SP-88002', barcode: '888000088002', categoryId: categoryMap.get('Snacks'), price: 3.99, costPrice: 1.50, stock: 150, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Snack Haven'), status: 'active' },

        // Frozen Foods
        { name: 'Frozen Blueberries', description: 'Anti-oxidant rich wild blueberries, flash-frozen.', sku: 'SP-99001', barcode: '888000099001', categoryId: categoryMap.get('Frozen Foods'), price: 7.99, costPrice: 4.00, stock: 45, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Fresh Farms Produce'), status: 'active' },
        { name: 'Margherita Pizza', description: 'Wood-fired frozen pizza with fresh mozzarella and basil.', sku: 'SP-99002', barcode: '888000099002', categoryId: categoryMap.get('Frozen Foods'), price: 11.49, costPrice: 6.00, stock: 25, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Pantry Essentials'), status: 'active' },
    ];

    for (const p of initialProducts) {
        await client.query(
            `INSERT INTO products(id, name, description, sku, barcode, category_id, supplier_id, price, cost_price, stock, image_urls, brand, status, store_id)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (store_id, sku) DO NOTHING;`,
            [generateId('prod'), p.name, p.description, p.sku, p.barcode, p.categoryId, p.supplierId, p.price, p.costPrice, p.stock, p.imageUrls, p.brand, p.status, storeId]
        );
    }
    console.log('✅ Sample products seeded.');
}


async function seedDatabase() {
    console.log('--- Starting Database Seeding ---');
    const pool = (db as any)._pool;
    const client = await pool.connect();
    try {
        await client.query('BEGIN'); // Start transaction
        await seedAdminUser(client);
        await seedSettings(client);
        await seedAccounts(client);
        await seedInitialData(client);
        await client.query('COMMIT'); // Commit transaction
        console.log('--- Database Seeding Complete ---');
    } catch (error) {
        await client.query('ROLLBACK'); // Rollback on error
        console.error('❌ Error seeding database:', error);
    } finally {
        client.release();
    }

}

export default seedDatabase;