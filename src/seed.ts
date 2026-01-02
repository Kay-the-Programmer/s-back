import db from './db_client';
import bcrypt from 'bcryptjs';
import { generateId } from './utils/helpers';
import { Pool } from 'pg';
import { StoreSettings, Account, Supplier, Category, Product } from './types';

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
    paymentMethods: [ { id: 'cash', name: 'Cash' }, { id: 'card', name: 'Credit/Debit Card' } ],
    supplierPaymentMethods: [ { id: 'bank_transfer', name: 'Bank Transfer' }, { id: 'check', name: 'Check' } ]
};

const initialAccounts: Omit<Account, 'id' | 'balance'>[] = [
    { number: '1010', name: 'Cash on Hand', type: 'asset', subType: 'cash', isDebitNormal: true, description: 'Physical cash and cash equivalents in the register.' },
    { number: '1100', name: 'Accounts Receivable', type: 'asset', subType: 'accounts_receivable', isDebitNormal: true, description: 'Money owed to the business by customers.' },
    { number: '1200', name: 'Inventory', type: 'asset', subType: 'inventory', isDebitNormal: true, description: 'Value of all products available for sale.' },
    { number: '2010', name: 'Accounts Payable', type: 'liability', subType: 'accounts_payable', isDebitNormal: false, description: 'Money owed to suppliers for inventory.' },
    { number: '2200', name: 'Sales Tax Payable', type: 'liability', subType: 'sales_tax_payable', isDebitNormal: false, description: 'Sales tax collected, to be remitted to the government.' },
    { number: '2300', name: 'Store Credit Payable', type: 'liability', subType: 'store_credit_payable', isDebitNormal: false, description: 'Total outstanding store credit owed to customers.' },
    { number: '3010', name: 'Owner\'s Equity', type: 'equity', isDebitNormal: false, description: 'Initial investment and retained earnings.' },
    { number: '4010', name: 'Sales Revenue', type: 'revenue', subType: 'sales_revenue', isDebitNormal: false, description: 'Default account for revenue from sales.' },
    { number: '5010', name: 'Cost of Goods Sold', type: 'expense', subType: 'cogs', isDebitNormal: true, description: 'Default account for the cost of goods sold.' },
    { number: '6010', name: 'Rent Expense', type: 'expense', isDebitNormal: true, description: 'Monthly rent for the store premises.' },
    { number: '6020', name: 'Inventory Adjustment Expense', type: 'expense', subType: 'inventory_adjustment', isDebitNormal: true, description: 'Expense from inventory shrinkage, damage, or adjustments.' },
];

const initialSuppliers: Omit<Supplier, 'id'>[] = [
    { name: 'World Coffee Importers', contactPerson: 'John Bean', email: 'sales@wcoffee.com', paymentTerms: 'Net 30' },
    { name: 'Green Leaf Teas', contactPerson: 'Jane Steep', email: 'contact@greenleaf.com', paymentTerms: 'Net 15' },
    { name: 'Local Mill & Co.', contactPerson: 'Bob Miller', email: 'orders@localmill.com', paymentTerms: 'COD' },
];

const initialCategories: Omit<Category, 'id'>[] = [
    { name: 'Beverages', parentId: null, attributes: [], revenueAccountId: undefined, cogsAccountId: undefined },
    { name: 'Bakery', parentId: null, attributes: [], revenueAccountId: undefined, cogsAccountId: undefined },
];

// --- Seeding Functions ---

async function seedAdminUser(client: any) {
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
    const supplierMap = new Map<string, string>();
    for (const sup of initialSuppliers) {
         let res = await client.query('SELECT id FROM suppliers WHERE name = $1', [sup.name]);
         if (res.rowCount === 0) {
            res = await client.query('INSERT INTO suppliers (id, name, contact_person, email, payment_terms) VALUES ($1, $2, $3, $4, $5) RETURNING id', [generateId('sup'), sup.name, sup.contactPerson, sup.email, sup.paymentTerms]);
         }
         if (res.rows[0]) supplierMap.set(sup.name, res.rows[0].id);
    }

    const categoryMap = new Map<string, string>();
    for (const cat of initialCategories) {
        let res = await client.query('SELECT id FROM categories WHERE name = $1 AND parent_id IS NULL', [cat.name]);
        if (res.rowCount === 0) {
            res = await client.query('INSERT INTO categories (id, name, parent_id, attributes) VALUES ($1, $2, $3, $4) RETURNING id', [generateId('cat'), cat.name, cat.parentId, '[]']);
        }
        if (res.rows[0]) categoryMap.set(cat.name, res.rows[0].id);
    }
    console.log('✅ Initial suppliers & categories seeded.');

    // --- Seed Products ---
    const initialProducts: Omit<Product, 'id'>[] = [
        { name: 'Premium Blend Coffee', description: 'A rich, full-bodied blend of Arabica beans from South America.', sku: 'SP-84321', barcode: '888000011122', categoryId: categoryMap.get('Beverages'), price: 18.99, costPrice: 12.50, stock: 50, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('World Coffee Importers'), brand: 'Global Roast', status: 'active' },
        { name: 'Organic Green Tea', description: 'Delicate and refreshing green tea, sourced from the finest gardens.', sku: 'SP-19874', barcode: '888000011133', categoryId: categoryMap.get('Beverages'), price: 12.49, costPrice: 8.00, stock: 75, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Green Leaf Teas'), brand: 'Zen Garden', status: 'active' },
        { name: 'Artisan Sourdough Bread', description: 'Naturally leavened sourdough with a crispy crust and chewy interior.', sku: 'SP-33215', barcode: '888000011144', categoryId: categoryMap.get('Bakery'), price: 6.99, costPrice: 3.50, stock: 25, imageUrls: ['/images/salepilot.png'], supplierId: supplierMap.get('Local Mill & Co.'), brand: 'The Bakehouse', status: 'active' },
        { name: 'Gourmet Chocolate Bar', description: '70% dark chocolate with hints of sea salt.', sku: 'SP-54321', price: 5.99, costPrice: 2.50, stock: 100, imageUrls: ['/images/salepilot.png'], status: 'active' },
    ];
    
    for (const p of initialProducts) {
        await client.query(
            `INSERT INTO products(id, name, description, sku, barcode, category_id, supplier_id, price, cost_price, stock, image_urls, brand, status)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (sku) DO NOTHING;`,
            [generateId('prod'), p.name, p.description, p.sku, p.barcode, p.categoryId, p.supplierId, p.price, p.costPrice, p.stock, p.imageUrls, p.brand, p.status]
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
        pool.end();
    }
}

seedDatabase();