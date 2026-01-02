import db from './db_client';
import bcrypt from 'bcryptjs';

function genId(prefix: string): string {
    return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36)}`;
}

async function initializeDatabase() {
    console.log('--- Initializing Database Tables / Migrations ---');
    const client = await (db as any)._pool.connect();

    try {
        // Phase A: Ensure critical auth table exists and is committed independently
        await client.query('BEGIN');
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE,
                password_hash TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('superadmin','admin','staff','inventory_manager'))
            );
        `);
        // Ensure role check allows superadmin on existing DBs
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.table_constraints
                    WHERE table_name='users' AND constraint_type='CHECK' AND constraint_name='users_role_check'
                ) THEN
                    ALTER TABLE users DROP CONSTRAINT users_role_check;
                END IF;
                ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin','admin','staff','inventory_manager'));
            END $$;`
        );
        // Seed a default admin user if none exists (safe, idempotent)
        const existingUsers = await client.query('SELECT 1 FROM users LIMIT 1');
        if (existingUsers.rowCount === 0) {
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash('password', salt);
            await client.query(
                'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
                ['user_admin_default', 'Admin User', 'admin@sale-pilot.com', passwordHash, 'admin']
            );
            console.log('✅ Default admin user created (admin@sale-pilot.com / password)');
        }
        // Ensure a superadmin exists for system-wide administration
        const superAdminEmail = process.env.SUPERADMIN_EMAIL || 'superadmin@sale-pilot.com';
        const superAdminCheck = await client.query('SELECT 1 FROM users WHERE email = $1', [superAdminEmail]);
        if (superAdminCheck.rowCount === 0) {
            const salt2 = await bcrypt.genSalt(10);
            const passwordHash2 = await bcrypt.hash(process.env.SUPERADMIN_PASSWORD || 'password', salt2);
            await client.query(
                'INSERT INTO users (id, name, email, password_hash, role) VALUES ($1, $2, $3, $4, $5)',
                ['user_superadmin_default', 'Super Admin', superAdminEmail, passwordHash2, 'superadmin']
            );
            console.log(`✅ Superadmin user created (${superAdminEmail} / ${process.env.SUPERADMIN_PASSWORD || 'password'})`);
        }
        await client.query('COMMIT');

        // Phase A1: Multi-tenant base tables and columns
        // Create stores table and add current_store_id to users
        await client.query(`
            CREATE TABLE IF NOT EXISTS stores (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
                subscription_status TEXT NOT NULL DEFAULT 'active' CHECK (subscription_status IN ('trial','active','past_due','canceled')),
                subscription_ends_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        // For existing DBs, ensure columns exist with proper defaults
        await client.query(`
            DO $$
            BEGIN
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS status TEXT;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_status TEXT;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
                -- Set defaults and checks if missing by re-adding constraints
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns WHERE table_name='stores' AND column_name='status'
                ) THEN
                    UPDATE stores SET status = COALESCE(status, 'active');
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns WHERE table_name='stores' AND column_name='subscription_status'
                ) THEN
                    UPDATE stores SET subscription_status = COALESCE(subscription_status, 'active');
                END IF;
            END $$;`
        );
        await client.query(`CREATE INDEX IF NOT EXISTS idx_stores_status ON stores(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_stores_subscription_status ON stores(subscription_status);`);
        await client.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.columns 
                    WHERE table_name = 'users' AND column_name = 'current_store_id'
                ) THEN
                    ALTER TABLE users ADD COLUMN current_store_id TEXT;
                END IF;
            END $$;
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_users_current_store_id ON users(current_store_id);`);
        // Add store_id to key domain tables if not present
        await client.query(`
            DO $$
            BEGIN
                -- Ensure store_id exists for legacy tables (idempotent, guarded by IF EXISTS)
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'products') THEN
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'categories') THEN
                    ALTER TABLE categories ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_categories_store_id ON categories(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers') THEN
                    ALTER TABLE customers ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_customers_store_id ON customers(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'suppliers') THEN
                    ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_suppliers_store_id ON suppliers(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales') THEN
                    ALTER TABLE sales ADD COLUMN IF NOT EXISTS store_id TEXT;
                    -- index created later as well; safe to create here too
                    CREATE INDEX IF NOT EXISTS idx_sales_store_id ON sales(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sale_items') THEN
                    ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_sale_items_store_id ON sale_items(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payments') THEN
                    ALTER TABLE payments ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_payments_store_id ON payments(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'returns') THEN
                    ALTER TABLE returns ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_returns_store_id ON returns(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'return_items') THEN
                    ALTER TABLE return_items ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_return_items_store_id ON return_items(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'purchase_orders') THEN
                    ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_purchase_orders_store_id ON purchase_orders(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'purchase_order_items') THEN
                    ALTER TABLE purchase_order_items ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_po_items_store_id ON purchase_order_items(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'po_receptions') THEN
                    ALTER TABLE po_receptions ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_po_receptions_store_id ON po_receptions(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'po_reception_items') THEN
                    ALTER TABLE po_reception_items ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_po_reception_items_store_id ON po_reception_items(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'stock_takes') THEN
                    ALTER TABLE stock_takes ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_stock_takes_store_id ON stock_takes(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'stock_take_items') THEN
                    ALTER TABLE stock_take_items ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_stock_take_items_store_id ON stock_take_items(store_id);
                END IF;
                -- Accounting tables
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'accounts') THEN
                    ALTER TABLE accounts ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_accounts_store_id ON accounts(store_id);
                    -- Replace global unique constraints with per-store unique indexes
                    IF EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'accounts_number_key'
                    ) THEN
                        ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_number_key;
                    END IF;
                    IF EXISTS (
                        SELECT 1 FROM pg_constraint WHERE conname = 'accounts_sub_type_key'
                    ) THEN
                        ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_sub_type_key;
                    END IF;
                    CREATE UNIQUE INDEX IF NOT EXISTS uidx_accounts_store_number ON accounts(store_id, number);
                    CREATE UNIQUE INDEX IF NOT EXISTS uidx_accounts_store_sub_type ON accounts(store_id, sub_type);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_entries') THEN
                    ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_journal_entries_store_id_date ON journal_entries(store_id, "date");
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'journal_entry_lines') THEN
                    ALTER TABLE journal_entry_lines ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_store_id_jeid ON journal_entry_lines(store_id, journal_entry_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
                    ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_audit_logs_store_id_timestamp ON audit_logs(store_id, "timestamp");
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_invoices') THEN
                    ALTER TABLE supplier_invoices ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_supplier_invoices_store_id ON supplier_invoices(store_id);
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'supplier_payments') THEN
                    ALTER TABLE supplier_payments ADD COLUMN IF NOT EXISTS store_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_supplier_payments_store_id ON supplier_payments(store_id);
                END IF;
            END $$;
        `);

        // Phase B0: Create core tables for a brand-new database (idempotent)
        // Suppliers
        await client.query(`
            CREATE TABLE IF NOT EXISTS suppliers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                contact_person TEXT,
                phone TEXT,
                email TEXT,
                address TEXT,
                payment_terms TEXT,
                banking_details TEXT,
                notes TEXT,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_suppliers_store_id ON suppliers(store_id);`);
        // Accounts (needed for references below) - tenant scoped
        await client.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                number TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
                sub_type TEXT CHECK (sub_type IN ('cash','accounts_receivable','inventory','accounts_payable','sales_tax_payable','sales_revenue','cogs','store_credit_payable','inventory_adjustment', NULL)),
                balance DECIMAL(12,2) NOT NULL DEFAULT 0,
                is_debit_normal BOOLEAN NOT NULL,
                description TEXT,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_accounts_store_id ON accounts(store_id);`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_accounts_store_number ON accounts(store_id, number);`);
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_accounts_store_sub_type ON accounts(store_id, sub_type);`);
        // Categories
        await client.query(`
            CREATE TABLE IF NOT EXISTS categories (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
                attributes JSONB NOT NULL DEFAULT '[]',
                revenue_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
                cogs_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_categories_store_id ON categories(store_id);`);
        // Products
        await client.query(`
            CREATE TABLE IF NOT EXISTS products (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT,
                sku TEXT NOT NULL UNIQUE,
                barcode TEXT UNIQUE,
                category_id TEXT REFERENCES categories(id),
                supplier_id TEXT REFERENCES suppliers(id),
                price DECIMAL(10,2) NOT NULL,
                cost_price DECIMAL(10,2),
                stock DECIMAL(10,3) NOT NULL DEFAULT 0,
                unit_of_measure TEXT NOT NULL DEFAULT 'unit' CHECK (unit_of_measure IN ('unit','kg')),
                image_urls TEXT[],
                brand TEXT,
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
                reorder_point INT,
                weight DECIMAL(10,3),
                dimensions TEXT,
                safety_stock INT,
                variants JSONB DEFAULT '[]',
                custom_attributes JSONB,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_products_store_id_status ON products(store_id, status);`);
        // Customers
        await client.query(`
            CREATE TABLE IF NOT EXISTS customers (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT,
                phone TEXT,
                address JSONB,
                notes TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                store_credit DECIMAL(10,2) NOT NULL DEFAULT 0,
                account_balance DECIMAL(10,2) NOT NULL DEFAULT 0,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_store_id ON customers(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_store_id_created_at ON customers(store_id, created_at);`);
        // Sales and related
        await client.query(`
            CREATE TABLE IF NOT EXISTS sales (
                transaction_id TEXT PRIMARY KEY,
                "timestamp" TIMESTAMPTZ NOT NULL,
                customer_id TEXT REFERENCES customers(id),
                total DECIMAL(10,2) NOT NULL,
                subtotal DECIMAL(10,2) NOT NULL,
                tax DECIMAL(10,2) NOT NULL,
                discount DECIMAL(10,2) NOT NULL,
                store_credit_used DECIMAL(10,2),
                payment_status TEXT NOT NULL CHECK (payment_status IN ('paid','unpaid','partially_paid')),
                amount_paid DECIMAL(10,2) NOT NULL,
                due_date DATE,
                refund_status TEXT NOT NULL DEFAULT 'none',
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_store_id ON sales(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_store_id_timestamp ON sales(store_id, "timestamp");`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS sale_items (
                id SERIAL PRIMARY KEY,
                sale_id TEXT NOT NULL REFERENCES sales(transaction_id) ON DELETE CASCADE,
                product_id TEXT NOT NULL REFERENCES products(id),
                quantity DECIMAL(10,3) NOT NULL,
                price_at_sale DECIMAL(10,2) NOT NULL,
                cost_at_sale DECIMAL(10,2),
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sale_items_store_id ON sale_items(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sale_items_store_id_sale_id ON sale_items(store_id, sale_id);`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS payments (
                id TEXT PRIMARY KEY,
                sale_id TEXT NOT NULL REFERENCES sales(transaction_id) ON DELETE CASCADE,
                date TIMESTAMPTZ NOT NULL,
                amount DECIMAL(10,2) NOT NULL,
                method TEXT NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_store_id ON payments(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_store_id_date ON payments(store_id, date);`);
        // Returns
        await client.query(`
            CREATE TABLE IF NOT EXISTS returns (
                id TEXT PRIMARY KEY,
                original_sale_id TEXT NOT NULL REFERENCES sales(transaction_id),
                "timestamp" TIMESTAMPTZ NOT NULL,
                refund_amount DECIMAL(10,2) NOT NULL,
                refund_method TEXT NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_returns_store_id ON returns(store_id);`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS return_items (
                id SERIAL PRIMARY KEY,
                return_id TEXT NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL REFERENCES products(id),
                product_name TEXT NOT NULL,
                quantity DECIMAL(10,3) NOT NULL,
                reason TEXT,
                add_to_stock BOOLEAN NOT NULL DEFAULT FALSE,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_return_items_store_id ON return_items(store_id);`);
        // Accounting journal (tenant-scoped)
        await client.query(`
            CREATE TABLE IF NOT EXISTS journal_entries (
                id TEXT PRIMARY KEY,
                "date" TIMESTAMPTZ NOT NULL,
                description TEXT NOT NULL,
                source_type TEXT NOT NULL CHECK (source_type IN ('sale','purchase','manual','payment')),
                source_id TEXT,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_journal_entries_store_id_date ON journal_entries(store_id, "date");`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS journal_entry_lines (
                id SERIAL PRIMARY KEY,
                journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
                account_id TEXT NOT NULL REFERENCES accounts(id),
                type TEXT NOT NULL CHECK (type IN ('debit','credit')),
                amount DECIMAL(10,2) NOT NULL,
                account_name TEXT NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_journal_entry_lines_store_id_jeid ON journal_entry_lines(store_id, journal_entry_id);`);
        // Audit logs (tenant-scoped)
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_logs (
                id TEXT PRIMARY KEY,
                "timestamp" TIMESTAMPTZ NOT NULL,
                user_id TEXT NOT NULL REFERENCES users(id),
                user_name TEXT NOT NULL,
                action TEXT NOT NULL,
                details TEXT NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_audit_logs_store_id_timestamp ON audit_logs(store_id, "timestamp");`);
        // System-wide notifications (global, not tenant-scoped)
        await client.query(`
            CREATE TABLE IF NOT EXISTS system_notifications (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_by TEXT NOT NULL REFERENCES users(id)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_system_notifications_created_at ON system_notifications(created_at DESC);`);

        // Subscription payments from store owners (system revenue)
        await client.query(`
            CREATE TABLE IF NOT EXISTS subscription_payments (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL REFERENCES stores(id),
                amount DECIMAL(10,2) NOT NULL,
                currency TEXT NOT NULL,
                period_start TIMESTAMPTZ,
                period_end TIMESTAMPTZ,
                paid_at TIMESTAMPTZ,
                method TEXT,
                reference TEXT,
                notes TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_subscription_payments_store_id ON subscription_payments(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_subscription_payments_paid_created ON subscription_payments(COALESCE(paid_at, created_at));`);
        // Store settings (per-store)
        await client.query(`
            CREATE TABLE IF NOT EXISTS store_settings (
                store_id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                address TEXT,
                phone TEXT,
                email TEXT,
                website TEXT,
                tax_rate DECIMAL(5,2) NOT NULL,
                currency JSONB NOT NULL,
                receipt_message TEXT,
                low_stock_threshold INT NOT NULL,
                sku_prefix TEXT,
                enable_store_credit BOOLEAN NOT NULL,
                payment_methods JSONB,
                supplier_payment_methods JSONB
            );
        `);
        // Migrate legacy singleton settings table to per-store if needed
        await client.query(`
            DO $$
            DECLARE
                has_store_id BOOLEAN;
                has_id_col BOOLEAN;
                legacy_row_count INT;
                chosen_store TEXT;
                pk_name TEXT;
            BEGIN
                -- Ensure store_settings table exists before altering
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'store_settings') THEN
                    SELECT EXISTS (
                        SELECT 1 FROM information_schema.columns
                        WHERE table_name = 'store_settings' AND column_name = 'store_id'
                    ) INTO has_store_id;

                    IF NOT has_store_id THEN
                        -- Add store_id column
                        ALTER TABLE store_settings ADD COLUMN store_id TEXT;

                        -- Determine a store id to migrate existing settings row (if any)
                        SELECT COUNT(*)::int FROM store_settings INTO legacy_row_count;
                        IF legacy_row_count > 0 THEN
                            -- Prefer a user's current_store_id
                            SELECT current_store_id FROM users WHERE current_store_id IS NOT NULL LIMIT 1 INTO chosen_store;
                            IF chosen_store IS NULL THEN
                                -- Fallback to any existing store
                                SELECT id FROM stores LIMIT 1 INTO chosen_store;
                            END IF;
                            IF chosen_store IS NULL THEN
                                -- Final fallback constant for migration; controller will upsert per real store later
                                chosen_store := 'default';
                            END IF;
                            UPDATE store_settings SET store_id = chosen_store WHERE store_id IS NULL;
                        END IF;

                        -- Drop legacy single-row constraint if present
                        IF EXISTS (
                            SELECT 1 FROM information_schema.table_constraints
                            WHERE table_name = 'store_settings' AND constraint_type = 'CHECK' AND constraint_name = 'single_row_check'
                        ) THEN
                            ALTER TABLE store_settings DROP CONSTRAINT single_row_check;
                        END IF;

                        -- Drop legacy primary key on id if present (constraint name could vary)
                        SELECT conname INTO pk_name FROM pg_constraint
                        WHERE conrelid = 'store_settings'::regclass AND contype = 'p' LIMIT 1;
                        IF pk_name IS NOT NULL THEN
                            EXECUTE 'ALTER TABLE store_settings DROP CONSTRAINT ' || quote_ident(pk_name);
                        END IF;

                        -- Add primary key on store_id (only if values are unique/non-null)
                        -- Ensure unique index first to avoid duplicates
                        BEGIN
                            CREATE UNIQUE INDEX IF NOT EXISTS uidx_store_settings_store_id ON store_settings(store_id);
                        EXCEPTION WHEN others THEN
                            NULL;
                        END;
                        -- Set store_id NOT NULL if at least the existing row was filled
                        BEGIN
                            ALTER TABLE store_settings ALTER COLUMN store_id SET NOT NULL;
                        EXCEPTION WHEN others THEN
                            NULL;
                        END;
                        -- Add PK on store_id
                        BEGIN
                            ALTER TABLE store_settings ADD PRIMARY KEY (store_id);
                        EXCEPTION WHEN others THEN
                            NULL;
                        END;

                        -- Keep the legacy id column for backward compatibility (no longer PK)
                    END IF;
                END IF;
            END $$;
        `);
        // Purchase orders
        await client.query(`
            CREATE TABLE IF NOT EXISTS purchase_orders (
                id TEXT PRIMARY KEY,
                po_number TEXT NOT NULL UNIQUE,
                supplier_id TEXT NOT NULL REFERENCES suppliers(id),
                supplier_name TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('draft','ordered','partially_received','received','canceled')),
                created_at TIMESTAMPTZ NOT NULL,
                ordered_at TIMESTAMPTZ,
                expected_at TIMESTAMPTZ,
                received_at TIMESTAMPTZ,
                notes TEXT,
                subtotal DECIMAL(10,2) NOT NULL,
                shipping_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
                tax DECIMAL(10,2) NOT NULL DEFAULT 0,
                total DECIMAL(10,2) NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_store_id ON purchase_orders(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_purchase_orders_store_id_created_at ON purchase_orders(store_id, created_at);`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS purchase_order_items (
                id SERIAL PRIMARY KEY,
                po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL REFERENCES products(id),
                product_name TEXT NOT NULL,
                sku TEXT NOT NULL,
                quantity DECIMAL(10,3) NOT NULL,
                cost_price DECIMAL(10,2) NOT NULL,
                received_quantity DECIMAL(10,3) NOT NULL DEFAULT 0,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_po_items_store_id ON purchase_order_items(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_po_items_store_id_po_id ON purchase_order_items(store_id, po_id);`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS po_receptions (
                id SERIAL PRIMARY KEY,
                po_id TEXT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
                reception_date TIMESTAMPTZ NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_po_receptions_store_id ON po_receptions(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_po_receptions_store_id_po_id ON po_receptions(store_id, po_id);`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS po_reception_items (
                id SERIAL PRIMARY KEY,
                reception_id INT NOT NULL REFERENCES po_receptions(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL REFERENCES products(id),
                product_name TEXT NOT NULL,
                quantity_received DECIMAL(10,3) NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_po_reception_items_store_id ON po_reception_items(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_po_reception_items_store_id_reception_id ON po_reception_items(store_id, reception_id);`);

        // Phase B: Seed minimal demo data on empty database (idempotent inserts)
        // Note: store_settings are now per-store and will be created on-demand when a store saves settings.
        // Seeding of settings is skipped here to avoid coupling to a specific store_id.
        // If needed, settings seeding can be performed in seed.ts where a store_id context may be available.

        // Seed accounts (Chart of Accounts)
        const accounts = [
            { number: '1010', name: 'Cash on Hand', type: 'asset', sub: 'cash', debit: true, desc: 'Physical cash and cash equivalents in the register.' },
            { number: '1100', name: 'Accounts Receivable', type: 'asset', sub: 'accounts_receivable', debit: true, desc: 'Money owed to the business by customers.' },
            { number: '1200', name: 'Inventory', type: 'asset', sub: 'inventory', debit: true, desc: 'Value of all products available for sale.' },
            { number: '2010', name: 'Accounts Payable', type: 'liability', sub: 'accounts_payable', debit: false, desc: 'Money owed to suppliers for inventory.' },
            { number: '2200', name: 'Sales Tax Payable', type: 'liability', sub: 'sales_tax_payable', debit: false, desc: 'Sales tax collected, to be remitted to the government.' },
            { number: '2300', name: 'Store Credit Payable', type: 'liability', sub: 'store_credit_payable', debit: false, desc: 'Total outstanding store credit owed to customers.' },
            { number: '3010', name: "Owner's Equity", type: 'equity', sub: null, debit: false, desc: 'Initial investment and retained earnings.' },
            { number: '4010', name: 'Sales Revenue', type: 'revenue', sub: 'sales_revenue', debit: false, desc: 'Default account for revenue from sales.' },
            { number: '5010', name: 'Cost of Goods Sold', type: 'expense', sub: 'cogs', debit: true, desc: 'Default account for the cost of goods sold.' },
            { number: '6010', name: 'Rent Expense', type: 'expense', sub: null, debit: true, desc: 'Monthly rent for the store premises.' },
            { number: '6020', name: 'Inventory Adjustment Expense', type: 'expense', sub: 'inventory_adjustment', debit: true, desc: 'Expense from inventory shrinkage, damage, or adjustments.' }
        ];
        const accCount = await client.query('SELECT COUNT(*)::int AS count FROM accounts');
        if ((accCount.rows?.[0]?.count ?? 0) === 0) {
            for (const a of accounts) {
                await client.query(
                    'INSERT INTO accounts (id, name, number, type, sub_type, is_debit_normal, description, balance, store_id) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8) ON CONFLICT (store_id, number) DO NOTHING',
                    [genId('acc'), a.name, a.number, a.type, a.sub, a.debit, a.desc, null]
                );
            }
        }

        // Seed suppliers
        const supplierDefs = [
            { name: 'World Coffee Importers', contact: 'John Bean', email: 'sales@wcoffee.com', terms: 'Net 30' },
            { name: 'Green Leaf Teas', contact: 'Jane Steep', email: 'contact@greenleaf.com', terms: 'Net 15' },
            { name: 'Local Mill & Co.', contact: 'Bob Miller', email: 'orders@localmill.com', terms: 'COD' }
        ];
        const supplierIds: Record<string,string> = {};
        for (const s of supplierDefs) {
            const found = await client.query('SELECT id FROM suppliers WHERE name = $1', [s.name]);
            if (found.rowCount && found.rows[0]) {
                supplierIds[s.name] = found.rows[0].id;
            } else {
                const id = genId('sup');
                await client.query('INSERT INTO suppliers (id, name, contact_person, email, payment_terms) VALUES ($1,$2,$3,$4,$5)', [id, s.name, s.contact, s.email, s.terms]);
                supplierIds[s.name] = id;
            }
        }

        // Seed categories
        const categoryDefs = ['Beverages','Bakery'];
        const categoryIds: Record<string,string> = {};
        for (const cname of categoryDefs) {
            const found = await client.query('SELECT id FROM categories WHERE name = $1 AND parent_id IS NULL', [cname]);
            if (found.rowCount && found.rows[0]) {
                categoryIds[cname] = found.rows[0].id;
            } else {
                const id = genId('cat');
                await client.query('INSERT INTO categories (id, name, parent_id, attributes) VALUES ($1,$2,$3,$4)', [id, cname, null, '[]']);
                categoryIds[cname] = id;
            }
        }

        // Seed a few sample products if table is empty
        const existingProducts = await client.query('SELECT 1 FROM products LIMIT 1');
        if (existingProducts.rowCount === 0) {
            const samples = [
                { name: 'Premium Blend Coffee', description: 'A rich, full-bodied blend of Arabica beans from South America.', sku: 'SP-84321', barcode: '888000011122', category: 'Beverages', price: 18.99, cost: 12.50, stock: 50, supplier: 'World Coffee Importers', brand: 'Global Roast', status: 'active' },
                { name: 'Organic Green Tea', description: 'Delicate and refreshing green tea, sourced from the finest gardens.', sku: 'SP-19874', barcode: '888000011133', category: 'Beverages', price: 12.49, cost: 8.00, stock: 75, supplier: 'Green Leaf Teas', brand: 'Zen Garden', status: 'active' },
                { name: 'Artisan Sourdough Bread', description: 'Naturally leavened sourdough with a crispy crust and chewy interior.', sku: 'SP-33215', barcode: '888000011144', category: 'Bakery', price: 6.99, cost: 3.50, stock: 25, supplier: 'Local Mill & Co.', brand: 'The Bakehouse', status: 'active' },
                { name: 'Gourmet Chocolate Bar', description: '70% dark chocolate with hints of sea salt.', sku: 'SP-54321', barcode: null, category: 'Bakery', price: 5.99, cost: 2.50, stock: 100, supplier: null, brand: null, status: 'active' }
            ];
            for (const p of samples) {
                await client.query(
                    `INSERT INTO products (id, name, description, sku, barcode, category_id, supplier_id, price, cost_price, stock, image_urls, brand, status)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
                     ON CONFLICT (sku) DO NOTHING`,
                    [genId('prod'), p.name, p.description, p.sku, p.barcode, p.category ? categoryIds[p.category] : null, p.supplier ? supplierIds[p.supplier!] : null, p.price, p.cost, p.stock, JSON.stringify(['/images/salepilot.png']), p.brand, p.status]
                );
            }
        }

        // Phase B: Best-effort optional migrations; guard against missing tables
        // Ensure unit_of_measure/status/etc only if products table exists
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables WHERE table_name = 'products'
                ) THEN
                    BEGIN
                        ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_of_measure TEXT;
                        ALTER TABLE products ALTER COLUMN unit_of_measure SET DEFAULT 'unit';
                        UPDATE products SET unit_of_measure = 'unit' WHERE unit_of_measure IS NULL;

                        -- Ensure columns used by products.controller exist in products table
                        ALTER TABLE products ADD COLUMN IF NOT EXISTS status TEXT;
                        ALTER TABLE products ALTER COLUMN status SET DEFAULT 'active';
                        UPDATE products SET status = 'active' WHERE status IS NULL;

                        ALTER TABLE products ADD COLUMN IF NOT EXISTS weight DECIMAL(10, 3);
                        ALTER TABLE products ADD COLUMN IF NOT EXISTS dimensions TEXT;
                        ALTER TABLE products ADD COLUMN IF NOT EXISTS safety_stock INT;
                        ALTER TABLE products ADD COLUMN IF NOT EXISTS variants JSONB;
                        ALTER TABLE products ALTER COLUMN variants SET DEFAULT '[]';
                        ALTER TABLE products ADD COLUMN IF NOT EXISTS custom_attributes JSONB;
                        ALTER TABLE products ALTER COLUMN custom_attributes SET DEFAULT '{}';
                    EXCEPTION WHEN others THEN
                        -- Swallow any unexpected errors to avoid aborting init
                        NULL;
                    END;
                END IF;
            END $$;
        `);

        // (Optional) Ensure stock is decimal to allow fractional kilos. Safe to skip if already correct.
        // Only attempt change when current type is integer
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'products' AND column_name = 'stock' AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE products ALTER COLUMN stock TYPE DECIMAL(10, 3) USING stock::DECIMAL(10,3);
                END IF;
            END $$;
        `);

        // Existing initialization creating supplier tables (kept for backward compat)
        await client.query(`
            CREATE TABLE IF NOT EXISTS supplier_invoices (
                id VARCHAR(50) PRIMARY KEY,
                invoice_number VARCHAR(50) NOT NULL,
                supplier_id VARCHAR(50),
                supplier_name VARCHAR(100) NOT NULL,
                purchase_order_id VARCHAR(50),
                po_number VARCHAR(50),
                invoice_date DATE NOT NULL,
                due_date DATE NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                amount_paid DECIMAL(10, 2) DEFAULT 0,
                status VARCHAR(20) DEFAULT 'unpaid',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_invoices_store_id ON supplier_invoices(store_id);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS supplier_payments (
                id VARCHAR(50) PRIMARY KEY,
                supplier_invoice_id VARCHAR(50) REFERENCES supplier_invoices(id),
                date DATE NOT NULL,
                amount DECIMAL(10, 2) NOT NULL,
                method VARCHAR(50) NOT NULL,
                reference VARCHAR(100),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_supplier_payments_store_id ON supplier_payments(store_id);`);

        // --- Stock Takes tables ---
        await client.query(`
            CREATE TABLE IF NOT EXISTS stock_takes (
                id TEXT PRIMARY KEY,
                start_time TIMESTAMPTZ NOT NULL,
                end_time TIMESTAMPTZ,
                status TEXT NOT NULL,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_stock_takes_store_id ON stock_takes(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_stock_takes_store_id_status ON stock_takes(store_id, status);`);

        // Ensure sale_items.quantity supports fractional quantities (e.g., 0.5 kg)
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'sale_items' AND column_name = 'quantity' AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE sale_items ALTER COLUMN quantity TYPE DECIMAL(10, 3) USING quantity::DECIMAL(10,3);
                END IF;
            END $$;
        `);

        // Ensure return_items.quantity supports fractional quantities
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'return_items' AND column_name = 'quantity' AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE return_items ALTER COLUMN quantity TYPE DECIMAL(10, 3) USING quantity::DECIMAL(10,3);
                END IF;
            END $$;
        `);

        // Ensure purchase_order_items quantities support fractional values
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'purchase_order_items' AND column_name = 'quantity' AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE purchase_order_items ALTER COLUMN quantity TYPE DECIMAL(10, 3) USING quantity::DECIMAL(10,3);
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'purchase_order_items' AND column_name = 'received_quantity' AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE purchase_order_items ALTER COLUMN received_quantity TYPE DECIMAL(10, 3) USING received_quantity::DECIMAL(10,3);
                END IF;
            END $$;
        `);

        // Ensure status constraint matches expected values (best-effort without error on duplicates)
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables WHERE table_name = 'stock_takes'
                ) THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.table_constraints
                        WHERE table_name = 'stock_takes' AND constraint_type = 'CHECK'
                    ) THEN
                        ALTER TABLE stock_takes
                        ADD CONSTRAINT stock_takes_status_check CHECK (status IN ('active', 'completed'));
                    END IF;
                END IF;
            END $$;
        `);

        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.tables WHERE table_name = 'products'
                ) THEN
                    CREATE TABLE IF NOT EXISTS stock_take_items (
                        id SERIAL PRIMARY KEY,
                        stock_take_id TEXT NOT NULL REFERENCES stock_takes(id) ON DELETE CASCADE,
                        product_id TEXT NOT NULL REFERENCES products(id),
                        name TEXT NOT NULL,
                        sku TEXT NOT NULL,
                        expected DECIMAL(10, 3) NOT NULL,
                        counted DECIMAL(10, 3),
                        store_id TEXT
                    );
                END IF;
            END $$;
        `);

        // Ensure expected/counted are decimal in case of legacy integer columns
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'stock_take_items' AND column_name = 'expected' AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE stock_take_items ALTER COLUMN expected TYPE DECIMAL(10, 3) USING expected::DECIMAL(10,3);
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_name = 'stock_take_items' AND column_name = 'counted' AND data_type IN ('integer', 'smallint', 'bigint')
                ) THEN
                    ALTER TABLE stock_take_items ALTER COLUMN counted TYPE DECIMAL(10, 3) USING counted::DECIMAL(10,3);
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_stock_take_items_stock_take_id ON stock_take_items(stock_take_id);
        `);
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_stock_take_items_store_id_stock_take_id ON stock_take_items(store_id, stock_take_id);
        `);

        console.log('✅ Database schema verified/updated successfully');
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    } finally {
        client.release(); // Release the client back to the pool, but don't end the pool
    }
}

// Run the initialization
initializeDatabase().catch(err => {
    console.error('Failed to initialize database:', err);
});

