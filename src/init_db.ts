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
                role TEXT NOT NULL CHECK (role IN ('superadmin','admin','staff','inventory_manager','customer','supplier')),
                phone TEXT,
                profile_picture TEXT
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
                ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('superadmin','admin','staff','inventory_manager','customer','supplier'));
                
                -- Add phone column if missing
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='phone') THEN
                    ALTER TABLE users ADD COLUMN phone TEXT;
                END IF;
                
                -- Add onboarding_state column if missing
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='onboarding_state') THEN
                    ALTER TABLE users ADD COLUMN onboarding_state JSONB DEFAULT '{"completedActions":[],"dismissedHelpers":[],"lastUpdated":null}'::jsonb;
                END IF;

                -- Add profile_picture column if missing
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='profile_picture') THEN
                    ALTER TABLE users ADD COLUMN profile_picture TEXT;
                END IF;

                -- Add email verification columns
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_verified') THEN
                    ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT FALSE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='verification_token') THEN
                    ALTER TABLE users ADD COLUMN verification_token TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='verification_token_expires') THEN
                    ALTER TABLE users ADD COLUMN verification_token_expires TIMESTAMPTZ;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='last_verification_sent_at') THEN
                    ALTER TABLE users ADD COLUMN last_verification_sent_at TIMESTAMPTZ;
                END IF;

                -- Add store-setup OTP columns (verify email before a store is created,
                -- so an abandoned setup never leaves an unverified store occupying the name)
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='store_setup_otp') THEN
                    ALTER TABLE users ADD COLUMN store_setup_otp TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='store_setup_otp_expires') THEN
                    ALTER TABLE users ADD COLUMN store_setup_otp_expires TIMESTAMPTZ;
                END IF;

                -- Add password reset columns
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='reset_password_token') THEN
                    ALTER TABLE users ADD COLUMN reset_password_token TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='reset_password_expires') THEN
                    ALTER TABLE users ADD COLUMN reset_password_expires TIMESTAMPTZ;
                END IF;

                -- Add referral columns
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='referral_code') THEN
                    ALTER TABLE users ADD COLUMN referral_code TEXT UNIQUE;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='referred_by') THEN
                    ALTER TABLE users ADD COLUMN referred_by TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='created_at') THEN
                    ALTER TABLE users ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
                END IF;
            END $$;`
        );
        // Seed a default admin user if none exists — DEV CONVENIENCE ONLY.
        // Never in production: it has a hardcoded well-known password.
        const existingUsers = await client.query('SELECT 1 FROM users LIMIT 1');
        if (existingUsers.rowCount === 0 && process.env.NODE_ENV !== 'production') {
            const salt = await bcrypt.genSalt(10);
            const passwordHash = await bcrypt.hash('password', salt);
            await client.query(
                'INSERT INTO users (id, name, email, password_hash, role, is_verified) VALUES ($1, $2, $3, $4, $5, TRUE)',
                ['user_admin_default', 'Admin User', 'admin@sale-pilot.com', passwordHash, 'admin']
            );
            console.log('✅ Default admin user created (admin@sale-pilot.com / password)');
        }
        // Ensure a superadmin exists for system-wide administration
        const superAdminEmail = process.env.SUPERADMIN_EMAIL || 'superadmin@sale-pilot.com';
        const superAdminCheck = await client.query('SELECT 1 FROM users WHERE email = $1', [superAdminEmail]);
        if (superAdminCheck.rowCount === 0) {
            // In production the password MUST come from the environment — seeding a
            // well-known default would hand over the platform control plane.
            const superAdminPassword = process.env.SUPERADMIN_PASSWORD
                || (process.env.NODE_ENV !== 'production' ? 'password' : null);
            if (!superAdminPassword) {
                throw new Error('FATAL: SUPERADMIN_PASSWORD must be set in production to seed the superadmin user.');
            }
            const salt2 = await bcrypt.genSalt(10);
            const passwordHash2 = await bcrypt.hash(superAdminPassword, salt2);
            await client.query(
                'INSERT INTO users (id, name, email, password_hash, role, is_verified) VALUES ($1, $2, $3, $4, $5, TRUE)',
                ['user_superadmin_default', 'Super Admin', superAdminEmail, passwordHash2, 'superadmin']
            );
            // Never log the password — container logs persist and are readable.
            console.log(`✅ Superadmin user created (${superAdminEmail})`);
        }
        // Idempotently ensure operator accounts are verified so the email-
        // verification gate can never lock them out — covers DBs seeded before
        // is_verified was set at insert time. Superadmin is also role-exempt.
        await client.query(
            `UPDATE users SET is_verified = TRUE
             WHERE (id IN ('user_admin_default', 'user_superadmin_default') OR email = $1)
               AND is_verified IS NOT TRUE`,
            [superAdminEmail]
        );
        await client.query('COMMIT');

        // Phase A1: Multi-tenant base tables and columns
        // Create stores table and add current_store_id to users
        await client.query(`
            CREATE TABLE IF NOT EXISTS stores (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive','suspended')),
                subscription_status TEXT NOT NULL DEFAULT 'trial' CHECK (subscription_status IN ('trial','active','past_due','canceled')),
                subscription_plan TEXT,
                subscription_ends_at TIMESTAMPTZ,
                is_verified BOOLEAN DEFAULT FALSE,
                verification_documents JSONB DEFAULT '[]',
                verification_token TEXT,
                verification_token_expires TIMESTAMPTZ,
                owner_id TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        // Multi-store ownership: which user owns/registered each store (enables the
        // Multi-Store Manager to list a user's businesses). Added after the fact.
        await client.query(`ALTER TABLE stores ADD COLUMN IF NOT EXISTS owner_id TEXT;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_stores_owner ON stores(owner_id);`);
        // Enforce store-name uniqueness at the DB level (registration checks it,
        // but only an index closes the SELECT→INSERT race). Guarded: if a legacy
        // DB already contains duplicate names, skip with a warning instead of
        // failing the whole init.
        await client.query(`
            DO $$
            BEGIN
                CREATE UNIQUE INDEX IF NOT EXISTS uidx_stores_name_lower ON stores (LOWER(trim(name)));
            EXCEPTION WHEN unique_violation OR others THEN
                RAISE WARNING 'Skipping unique store-name index (duplicate names exist?): %', SQLERRM;
            END $$;
        `);
        // The backfill below reads users.current_store_id, which on a FRESH
        // database is only added by a later migration block — ensure it exists
        // first (no-op on existing DBs) so first-boot init doesn't abort.
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS current_store_id TEXT;`);
        // Best-effort backfill: the admin currently pointing at a store becomes its owner.
        await client.query(`
            UPDATE stores s SET owner_id = u.id
            FROM users u
            WHERE s.owner_id IS NULL AND u.current_store_id = s.id AND u.role IN ('admin','superadmin');
        `);
        // For existing DBs, ensure columns exist with proper defaults
        await client.query(`
            DO $$
            BEGIN
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS status TEXT;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_status TEXT;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_plan TEXT;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMPTZ;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT FALSE;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS verification_documents JSONB DEFAULT '[]';
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS verification_token TEXT;
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS verification_token_expires TIMESTAMPTZ;
                -- Reason a superadmin suspended/deactivated the store; surfaced in
                -- the store-status 403 so the operator learns why access was cut off.
                ALTER TABLE stores ADD COLUMN IF NOT EXISTS status_reason TEXT;
                -- Set defaults and checks if missing by re-adding constraints
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns WHERE table_name='stores' AND column_name='status'
                ) THEN
                    UPDATE stores SET status = COALESCE(status, 'active');
                END IF;
                IF EXISTS (
                    SELECT 1 FROM information_schema.columns WHERE table_name='stores' AND column_name='subscription_status'
                ) THEN
                    UPDATE stores SET subscription_status = COALESCE(subscription_status, 'trial');
                END IF;

                -- Add discount_balance column
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='stores' AND column_name='discount_balance') THEN
                    ALTER TABLE stores ADD COLUMN discount_balance DECIMAL(10,2) DEFAULT 0;
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

                -- Payments table reference column migration
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payments') THEN
                    ALTER TABLE payments ADD COLUMN IF NOT EXISTS reference TEXT;
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
                sku TEXT NOT NULL,
                barcode TEXT,
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
                store_id TEXT,
                carton_price NUMERIC(12,4),
                units_per_carton INT,
                cartons_received INT,
                -- Standard-rated, zero-rated, or exempt. Zero and exempt both
                -- attract no tax but are reported differently on a VAT return,
                -- so they are not collapsed into one.
                tax_class TEXT NOT NULL DEFAULT 'standard'
                    CHECK (tax_class IN ('standard','zero','exempt'))
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_products_store_id ON products(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_products_store_id_status ON products(store_id, status);`);

        // Migration: Switch from global unique constraints to store-scoped unique indexes
        // Migration: Add carton pricing fields
        await client.query(`
            DO $$
            BEGIN
                -- Drop old global unique constraints if they exist
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_sku_key') THEN
                    ALTER TABLE products DROP CONSTRAINT products_sku_key;
                END IF;
                IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_barcode_key') THEN
                    ALTER TABLE products DROP CONSTRAINT products_barcode_key;
                END IF;

                -- Drop old unique indexes if they exist (sometimes named implicitly)
                DROP INDEX IF EXISTS products_sku_key;
                DROP INDEX IF EXISTS products_barcode_key;
                
                -- Add carton fields if missing
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'products') THEN
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS carton_price NUMERIC(12,4) DEFAULT NULL;
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS units_per_carton INTEGER DEFAULT NULL;
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS cartons_received INTEGER DEFAULT NULL;
                    -- B2B wholesale marketplace: per-unit price for retailer buyers
                    -- (NULL = use the retail price) and minimum order quantity.
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS wholesale_price NUMERIC(12,2) DEFAULT NULL;
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS min_order_quantity INTEGER DEFAULT NULL;
                    -- Quantity-break tiers for wholesale buyers:
                    -- [{"minQty":12,"price":5.00}, ...] sorted ascending.
                    ALTER TABLE products ADD COLUMN IF NOT EXISTS price_tiers JSONB DEFAULT NULL;
                END IF;
            END $$;
        `);

        // Create new store-scoped unique indexes
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_products_store_sku ON products(store_id, sku);`);
        // Only enforce unique barcode if barcode is not null (Postgres ignores nulls in unique indexes by default, but explicit is good)
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uidx_products_store_barcode ON products(store_id, barcode) WHERE barcode IS NOT NULL;`);

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
        // Link store-scoped customer records to a marketplace user account.
        // customers.id is a GLOBAL PK, so a signed-in buyer cannot reuse their
        // user id as the customer id in more than one store — per-store records
        // get their own ids and point back to the account via user_id.
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS user_id TEXT;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_customers_user_id ON customers(user_id);`);
        // Backfill: legacy rows created by online checkout used id = users.id.
        await client.query(`UPDATE customers SET user_id = id WHERE user_id IS NULL AND id IN (SELECT id FROM users);`);
        // Trade credit: cap on a customer's outstanding balance for online
        // orders (NULL = no cap; today's unrestricted pay-on-delivery).
        await client.query(`ALTER TABLE customers ADD COLUMN IF NOT EXISTS credit_limit DECIMAL(12,2) DEFAULT NULL;`);
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
                fulfillment_status TEXT NOT NULL DEFAULT 'fulfilled' CHECK (fulfillment_status IN ('pending','fulfilled','shipped','cancelled')),
                channel TEXT NOT NULL DEFAULT 'pos' CHECK (channel IN ('pos','online')),
                customer_details JSONB,
                amount_paid DECIMAL(10,2) NOT NULL,
                due_date DATE,
                refund_status TEXT NOT NULL DEFAULT 'none',
                store_id TEXT,
                attended_by TEXT,
                attended_by_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_store_id ON sales(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_store_id_timestamp ON sales(store_id, "timestamp");`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_fulfillment_status ON sales(fulfillment_status);`);

        // SMS message log (Africa's Talking). Store-scoped CRM messaging history.
        await client.query(`
            CREATE TABLE IF NOT EXISTS sms_messages (
                id TEXT PRIMARY KEY,
                store_id TEXT,
                customer_id TEXT,
                recipient TEXT NOT NULL,
                message TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending',
                provider TEXT DEFAULT 'africastalking',
                provider_message_id TEXT,
                cost TEXT,
                error TEXT,
                sent_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sms_messages_store_created ON sms_messages(store_id, created_at);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sms_messages_customer ON sms_messages(customer_id);`);

        // Migration for existing sales table
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sales') THEN
                    ALTER TABLE sales ADD COLUMN IF NOT EXISTS fulfillment_status TEXT CHECK (fulfillment_status IN ('pending','fulfilled','shipped','cancelled'));
                    ALTER TABLE sales ADD COLUMN IF NOT EXISTS channel TEXT CHECK (channel IN ('pos','online'));
                    ALTER TABLE sales ADD COLUMN IF NOT EXISTS customer_details JSONB;
                    -- Cashier attribution shown on receipts ("Attended by")
                    ALTER TABLE sales ADD COLUMN IF NOT EXISTS attended_by TEXT;
                    ALTER TABLE sales ADD COLUMN IF NOT EXISTS attended_by_id TEXT;
                    -- Online-order delivery fee (0 for POS/pickup); included in total
                    ALTER TABLE sales ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0;
                    -- 'accepted': supplier confirmed an online order (between
                    -- pending and fulfilled/shipped). Recreate the CHECK to
                    -- include it (constraint name follows PG's default).
                    ALTER TABLE sales DROP CONSTRAINT IF EXISTS sales_fulfillment_status_check;
                    ALTER TABLE sales ADD CONSTRAINT sales_fulfillment_status_check
                        CHECK (fulfillment_status IN ('pending','accepted','fulfilled','shipped','cancelled'));
                    
                    ALTER TABLE sales ALTER COLUMN fulfillment_status SET DEFAULT 'fulfilled';
                    ALTER TABLE sales ALTER COLUMN channel SET DEFAULT 'pos';
                    
                    UPDATE sales SET fulfillment_status = 'fulfilled' WHERE fulfillment_status IS NULL;
                    UPDATE sales SET channel = 'pos' WHERE channel IS NULL;

                    -- Re-apply NOT NULL constraints after population
                    ALTER TABLE sales ALTER COLUMN fulfillment_status SET NOT NULL;
                    ALTER TABLE sales ALTER COLUMN channel SET NOT NULL;
                END IF;
            END $$;
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS sale_items (
                id SERIAL PRIMARY KEY,
                sale_id TEXT NOT NULL REFERENCES sales(transaction_id) ON DELETE CASCADE,
                product_id TEXT NOT NULL REFERENCES products(id),
                quantity DECIMAL(10,3) NOT NULL,
                price_at_sale DECIMAL(10,2) NOT NULL,
                cost_at_sale DECIMAL(10,2),
                returned_quantity DECIMAL(10,3) NOT NULL DEFAULT 0,
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
                reference TEXT,
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_store_id ON payments(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_store_id_date ON payments(store_id, date);`);
        // Configurable transactional email templates (platform-wide, superadmin-owned).
        // Drives the automated email engine — see services/email-template.service.ts.
        await client.query(`
            CREATE TABLE IF NOT EXISTS email_templates (
                key TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                subject TEXT NOT NULL,
                html TEXT NOT NULL,
                enabled BOOLEAN NOT NULL DEFAULT true,
                config JSONB NOT NULL DEFAULT '{}'::jsonb,
                category TEXT NOT NULL DEFAULT 'event',
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_by TEXT
            );
        `);
        // Custom (superadmin-built) tips live only in this table, so the row —
        // not a code definition — carries its category. Backfill for older DBs.
        await client.query(`ALTER TABLE email_templates ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'event';`);
        // Returns
        await client.query(`
            CREATE TABLE IF NOT EXISTS returns (
                id TEXT PRIMARY KEY,
                original_sale_id TEXT NOT NULL REFERENCES sales(transaction_id),
                "timestamp" TIMESTAMPTZ NOT NULL,
                refund_amount DECIMAL(10,2) NOT NULL,
                tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
                subtotal_amount DECIMAL(10,2) NOT NULL DEFAULT 0,
                refund_method TEXT NOT NULL,
                -- How much of this refund was settled in REPLACEMENT GOODS
                -- rather than money. An exchange refunds the full value of what
                -- came back, but only the part not spent on replacements
                -- actually leaves the drawer; cash paid out is therefore
                -- refund_amount minus exchange_credit_applied. Without this the
                -- two are indistinguishable and a till count can't be checked.
                exchange_credit_applied DECIMAL(10,2) NOT NULL DEFAULT 0,
                store_id TEXT
            );
        `);
        await client.query(
            `ALTER TABLE returns ADD COLUMN IF NOT EXISTS exchange_credit_applied DECIMAL(10,2) NOT NULL DEFAULT 0;`,
        );

        // --- Per-product tax classes and tax-inclusive pricing ---
        //
        // One flat store rate charged tax on everything, which is wrong for any
        // shop selling both zero-rated staples and standard-rated goods. Both
        // defaults below reproduce the previous behaviour exactly, so upgrading
        // changes no price until someone reclassifies a product.
        await client.query(
            `ALTER TABLE products ADD COLUMN IF NOT EXISTS tax_class TEXT NOT NULL DEFAULT 'standard';`,
        );
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM information_schema.constraint_column_usage
                     WHERE table_name = 'products' AND constraint_name = 'products_tax_class_check'
                ) THEN
                    ALTER TABLE products ADD CONSTRAINT products_tax_class_check
                        CHECK (tax_class IN ('standard','zero','exempt'));
                END IF;
            END $$;
        `);
        await client.query(
            `ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT FALSE;`,
        );

        // The tax charged, broken down by class, frozen at the moment of sale.
        //
        // Stored rather than recomputed because a receipt is a record of what
        // was charged: recomputing it later against today's rate, or against a
        // product since reclassified, would reprint a different document from
        // the one the customer holds. Also the only way a receipt reprinted
        // months on can still show a valid tax breakdown.
        await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS tax_breakdown JSONB;`);

        // --- Manager overrides ---
        //
        // Roles say what someone may always do. An override says what someone
        // may do once, now, because a supervisor stood at the till and allowed
        // it. Without this a cashier either permanently can discount a sale to
        // nothing or permanently cannot, and shops resolve that by sharing the
        // manager login — which ends the audit trail entirely.
        //
        // A PIN rather than a password because this is typed at a counter with
        // a customer waiting. It is a weaker factor, so it is bcrypt-hashed,
        // rate-limited, minimum six digits, and every use is recorded.
        await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_pin_hash TEXT;`);

        // One authorisation, for one action, once. Single-use and short-lived
        // so a code cannot be reused for a second discount after the manager
        // has walked away.
        await client.query(`
            CREATE TABLE IF NOT EXISTS override_authorizations (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL,
                action TEXT NOT NULL
                    CHECK (action IN ('discount','refund','pay_out','no_sale')),
                -- The ceiling this authorisation covers. A manager approving a
                -- 20% discount has not approved a 90% one, so the amount is
                -- bound into the authorisation and rechecked when it is spent.
                max_amount DECIMAL(12,2),
                authorized_by TEXT NOT NULL,
                authorized_by_id TEXT,
                requested_by TEXT,
                requested_by_id TEXT,
                reason TEXT,
                created_at TIMESTAMPTZ NOT NULL,
                expires_at TIMESTAMPTZ NOT NULL,
                used_at TIMESTAMPTZ
            );
        `);
        await client.query(
            `CREATE INDEX IF NOT EXISTS override_auth_store_idx ON override_authorizations (store_id, used_at);`,
        );

        // When a manager must be asked, per store. Null means never — which is
        // exactly how every store behaved before this existed.
        await client.query(
            `ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS override_thresholds JSONB;`,
        );

        // A document freezes the tax mode it was issued under alongside its rate,
        // so editing an old invoice cannot reprice it against a setting the store
        // has changed since.
        await client.query(`ALTER TABLE sales_documents ADD COLUMN IF NOT EXISTS prices_include_tax BOOLEAN NOT NULL DEFAULT FALSE;`);

        // The class each line was sold under, for tax reporting that needs to
        // go deeper than the sale total.
        await client.query(
            `ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS tax_class TEXT;`,
        );

        // --- Cash drawer sessions (the till) ---
        //
        // A shift at one till: opened with a counted float, closed with a
        // counted drawer. Everything between is attributed to it, which turns
        // "the cash is short" into "the cash is short on Mary's Tuesday till".
        await client.query(`
            CREATE TABLE IF NOT EXISTS cash_sessions (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL,
                opened_by TEXT NOT NULL,
                opened_by_id TEXT,
                opened_at TIMESTAMPTZ NOT NULL,
                opening_float DECIMAL(12,2) NOT NULL DEFAULT 0,
                closed_by TEXT,
                closed_by_id TEXT,
                closed_at TIMESTAMPTZ,
                -- What the cashier counted, what the books say, and the gap.
                -- All three are stored rather than recomputed: a Z report
                -- records what was found at the time, and recomputing it later
                -- from sales since edited or refunded would quietly rewrite it.
                counted_cash DECIMAL(12,2),
                expected_cash DECIMAL(12,2),
                variance DECIMAL(12,2),
                status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
                notes TEXT
            );
        `);

        // One open till per person per store. Enforced by the database because
        // a double-tap on "Open till" would otherwise create two sessions and
        // split a shift's takings across both.
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_per_user
                ON cash_sessions (store_id, opened_by_id)
                WHERE status = 'open';
        `);

        // Money crossing the drawer that is not a sale: a float top-up, paying
        // a delivery driver, taking the takings to the bank. Without these
        // every such movement reads as a shortage at closing time.
        await client.query(`
            CREATE TABLE IF NOT EXISTS cash_movements (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL REFERENCES cash_sessions(id) ON DELETE CASCADE,
                store_id TEXT NOT NULL,
                type TEXT NOT NULL CHECK (type IN ('pay_in','pay_out')),
                amount DECIMAL(12,2) NOT NULL CHECK (amount > 0),
                reason TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL,
                created_by TEXT,
                created_by_id TEXT
            );
        `);
        await client.query(
            `CREATE INDEX IF NOT EXISTS cash_movements_session_idx ON cash_movements (session_id);`,
        );

        // Which till a sale or refund passed through. Stamped by the server
        // from the cashier's open session, so an offline till and the desktop
        // app land in the right session without either knowing sessions exist.
        // Null for anything rung up with no till open, which keeps every sale
        // that predates this feature valid.
        await client.query(`ALTER TABLE sales ADD COLUMN IF NOT EXISTS cash_session_id TEXT;`);
        await client.query(`ALTER TABLE returns ADD COLUMN IF NOT EXISTS cash_session_id TEXT;`);
        await client.query(
            `CREATE INDEX IF NOT EXISTS sales_cash_session_idx ON sales (cash_session_id);`,
        );
        await client.query(
            `CREATE INDEX IF NOT EXISTS returns_cash_session_idx ON returns (cash_session_id);`,
        );

        // Migration for returns table
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'returns') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'tax_amount') THEN
                        ALTER TABLE returns ADD COLUMN tax_amount DECIMAL(10,2) NOT NULL DEFAULT 0;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'returns' AND column_name = 'subtotal_amount') THEN
                        ALTER TABLE returns ADD COLUMN subtotal_amount DECIMAL(10,2) NOT NULL DEFAULT 0;
                    END IF;
                END IF;
            END $$;
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
                plan_id TEXT,
                period_start TIMESTAMPTZ,
                period_end TIMESTAMPTZ,
                paid_at TIMESTAMPTZ,
                method TEXT,
                reference TEXT,
                transaction_id TEXT,
                status TEXT DEFAULT 'pending',
                notes TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        // Migration for existing subscription_payments table
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'subscription_payments') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'subscription_payments' AND column_name = 'plan_id') THEN
                        ALTER TABLE subscription_payments ADD COLUMN plan_id TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'subscription_payments' AND column_name = 'transaction_id') THEN
                        ALTER TABLE subscription_payments ADD COLUMN transaction_id TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'subscription_payments' AND column_name = 'status') THEN
                        ALTER TABLE subscription_payments ADD COLUMN status TEXT DEFAULT 'pending';
                    END IF;
                END IF;
            END $$;
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_subscription_payments_store_id ON subscription_payments(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_subscription_payments_paid_created ON subscription_payments(COALESCE(paid_at, created_at));`);

        // Referral rewards table
        await client.query(`
            CREATE TABLE IF NOT EXISTS referral_rewards (
                id TEXT PRIMARY KEY,
                referrer_id TEXT NOT NULL REFERENCES users(id),
                referred_user_id TEXT NOT NULL REFERENCES users(id),
                reward_type TEXT NOT NULL DEFAULT 'discount',
                reward_value DECIMAL(10,2) NOT NULL,
                is_processed BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_referral_rewards_referrer_id ON referral_rewards(referrer_id);`);

        // Notification logs for periodic tasks
        await client.query(`
            CREATE TABLE IF NOT EXISTS periodic_notification_logs (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                notification_type TEXT NOT NULL,
                sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_periodic_notifications_user_type ON periodic_notification_logs(user_id, notification_type);`);
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
                supplier_payment_methods JSONB,
                is_online_store_enabled BOOLEAN NOT NULL DEFAULT TRUE,
                lenco_public_key TEXT,
                lenco_secret_key TEXT,
                -- Shelf prices already contain tax, so it is extracted from the
                -- price rather than added to it. Most retail here quotes
                -- tax-inclusive prices; the default is off so no existing
                -- store changes what it charges on upgrade.
                prices_include_tax BOOLEAN NOT NULL DEFAULT FALSE
            );
        `);
        // Premium add-on entitlements (modular packaging). Empty by default, so
        // gated features such as SMS messaging start locked until granted.
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS enabled_modules TEXT[] NOT NULL DEFAULT '{}';`);
        // B2B wholesale marketplace: stores that opt in are listed as suppliers
        // on /marketplace so retailers can source stock from them.
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS is_wholesale_supplier BOOLEAN NOT NULL DEFAULT FALSE;`);
        // Flat delivery fee charged on online orders fulfilled by delivery.
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS delivery_fee DECIMAL(10,2) NOT NULL DEFAULT 0;`);
        // Waive the delivery fee for orders at/above this subtotal (NULL = never).
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS free_delivery_above DECIMAL(12,2) DEFAULT NULL;`);
        // Public storefront/marketplace blurb shown on supplier cards + shop hero.
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS store_description TEXT;`);
        // Store logo (uploaded via POST /settings/logo, served from /uploads).
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS logo_url TEXT;`);
        // Taxpayer ID + the trading line under the business name. Both are printed
        // on receipts, delivery notes, quotations and invoices — a Zambian
        // receipt is not valid paperwork without the TPIN.
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS tpin TEXT;`);
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS business_tagline TEXT;`);
        // Bank accounts printed on invoices so a customer knows where to pay.
        // Kept on the store (not on each invoice) because they're the same
        // details every time — entered once, reused on every invoice after.
        // JSONB rather than a table for the same reason payment_methods is: a
        // short, store-scoped list that is always read and written whole.
        await client.query(`ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS bank_accounts JSONB NOT NULL DEFAULT '[]'::jsonb;`);
        // Product reviews: one per buyer per product, gated server-side to
        // verified purchases. Aggregates are denormalized onto products
        // (rating_avg/rating_count, updated in the review-write transaction)
        // so listing queries stay single-table.
        await client.query(`
            CREATE TABLE IF NOT EXISTS product_reviews (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL,
                product_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                order_id TEXT,
                author_name TEXT,
                rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
                comment TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (store_id, product_id, user_id)
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_reviews_product ON product_reviews(store_id, product_id);`);
        await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_avg NUMERIC(3,2) DEFAULT NULL;`);
        await client.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS rating_count INT NOT NULL DEFAULT 0;`);

        // Trigram indexes keep the public %substring% product search fast as
        // catalogs grow (queries use ILIKE, which these GIN indexes serve).
        try {
            await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_products_name_trgm ON products USING GIN (name gin_trgm_ops);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_products_desc_trgm ON products USING GIN (description gin_trgm_ops);`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_products_brand_trgm ON products USING GIN (brand gin_trgm_ops);`);
        } catch (e) {
            console.warn('[init_db] pg_trgm unavailable — product search stays unindexed:', (e as Error).message);
        }
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

                    -- Add missing columns for existing tables
                    ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS supplier_payment_methods JSONB;
                    ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS is_online_store_enabled BOOLEAN NOT NULL DEFAULT TRUE;
                    ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS lenco_public_key TEXT;
                    ALTER TABLE store_settings ADD COLUMN IF NOT EXISTS lenco_secret_key TEXT;

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
                supplier_id TEXT REFERENCES suppliers(id),
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
        // Supplier is optional: a store often raises an order before it has
        // decided (or recorded) who it is buying from. Existing databases were
        // created with supplier_id NOT NULL, so drop it here too.
        await client.query(`ALTER TABLE purchase_orders ALTER COLUMN supplier_id DROP NOT NULL;`);
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

        await client.query(`CREATE INDEX IF NOT EXISTS idx_po_reception_items_store_id_reception_id ON po_reception_items(store_id, reception_id);`);

        // Order lists — Hustle "Quick Lists": lightweight shopping/restock checklists
        // that need no supplier or catalogue. Items are stored inline as JSONB.
        await client.query(`
            CREATE TABLE IF NOT EXISTS order_lists (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'Order list',
                items JSONB NOT NULL DEFAULT '[]'::jsonb,
                created_at BIGINT NOT NULL,
                imported_at BIGINT,
                store_id TEXT NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_order_lists_store_id ON order_lists(store_id);`);

        // Offers (Location-based)
        await client.query(`
            CREATE TABLE IF NOT EXISTS offers (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL REFERENCES users(id),
                title TEXT NOT NULL,
                description TEXT,
                latitude DECIMAL(10, 8) NOT NULL,
                longitude DECIMAL(11, 8) NOT NULL,
                status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'completed', 'cancelled')),
                accepted_by TEXT REFERENCES users(id),
                store_id TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_user_id ON offers(user_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_offers_accepted_by ON offers(accepted_by);`);

        // Offer Messages (Chat)
        await client.query(`
            CREATE TABLE IF NOT EXISTS offer_messages (
                id TEXT PRIMARY KEY,
                offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
                sender_id TEXT NOT NULL REFERENCES users(id),
                content TEXT,
                image_url TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_offer_messages_offer_id ON offer_messages(offer_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_offer_messages_sender_id ON offer_messages(sender_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_offer_messages_created_at ON offer_messages(created_at);`);

        // Phase B: Seed minimal demo data on empty database (idempotent inserts)        // Note: store_settings are now per-store and will be created on-demand when a store saves settings.
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
        const supplierIds: Record<string, string> = {};
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
        const categoryDefs = ['Beverages', 'Bakery'];
        const categoryIds: Record<string, string> = {};
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
            // Find a store id to seed products (prefer a real one)
            const storeRes = await client.query('SELECT current_store_id FROM users WHERE current_store_id IS NOT NULL LIMIT 1');
            const chosenStore = storeRes.rows?.[0]?.current_store_id || null;

            const samples = [
                { name: 'Premium Blend Coffee', description: 'A rich, full-bodied blend of Arabica beans from South America.', sku: 'SP-84321', barcode: '888000011122', category: 'Beverages', price: 18.99, cost: 12.50, stock: 50, supplier: 'World Coffee Importers', brand: 'Global Roast', status: 'active' },
                { name: 'Organic Green Tea', description: 'Delicate and refreshing green tea, sourced from the finest gardens.', sku: 'SP-19874', barcode: '888000011133', category: 'Beverages', price: 12.49, cost: 8.00, stock: 75, supplier: 'Green Leaf Teas', brand: 'Zen Garden', status: 'active' },
                { name: 'Artisan Sourdough Bread', description: 'Naturally leavened sourdough with a crispy crust and chewy interior.', sku: 'SP-33215', barcode: '888000011144', category: 'Bakery', price: 6.99, cost: 3.50, stock: 25, supplier: 'Local Mill & Co.', brand: 'The Bakehouse', status: 'active' },
                { name: 'Gourmet Chocolate Bar', description: '70% dark chocolate with hints of sea salt.', sku: 'SP-54321', barcode: null, category: 'Bakery', price: 5.99, cost: 2.50, stock: 100, supplier: null, brand: null, status: 'active' }
            ];
            for (const p of samples) {
                await client.query(
                    `INSERT INTO products (id, name, description, sku, barcode, category_id, supplier_id, price, cost_price, stock, image_urls, brand, status, store_id)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
                     ON CONFLICT (store_id, sku) DO NOTHING`,
                    [genId('prod'), p.name, p.description, p.sku, p.barcode, p.category ? categoryIds[p.category] : null, p.supplier ? supplierIds[p.supplier!] : null, p.price, p.cost, p.stock, ['/images/salepilot.png'], p.brand, p.status, chosenStore]
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

        // --- Expenses table ---
        await client.query(`
            CREATE TABLE IF NOT EXISTS expenses (
                id VARCHAR(50) PRIMARY KEY,
                store_id TEXT NOT NULL,
                date DATE NOT NULL,
                description TEXT NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                expense_account_id VARCHAR(50) NOT NULL,
                expense_account_name VARCHAR(255) NOT NULL,
                payment_account_id VARCHAR(50) NOT NULL,
                payment_account_name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                reference VARCHAR(100),
                created_by VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        // How the money went out, in the store's OWN words — the same payment
        // methods Settings offers and the till records on a sale. The GL still
        // posts to payment_account_id (Cash or Accounts Payable); this keeps the
        // detail that a ledger account can't carry, so "paid by MTN" survives
        // and expense reporting can be read next to sales reporting.
        await client.query(`ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_store_date ON expenses(store_id, date DESC);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_expenses_store_account ON expenses(store_id, expense_account_id);`);

        // --- Recurring Expenses table ---
        await client.query(`
            CREATE TABLE IF NOT EXISTS recurring_expenses (
                id VARCHAR(50) PRIMARY KEY,
                store_id TEXT NOT NULL,
                description TEXT NOT NULL,
                amount DECIMAL(12, 2) NOT NULL,
                expense_account_id VARCHAR(50) NOT NULL,
                expense_account_name VARCHAR(255) NOT NULL,
                payment_account_id VARCHAR(50) NOT NULL,
                payment_account_name VARCHAR(255) NOT NULL,
                category VARCHAR(100),
                reference VARCHAR(100),
                frequency VARCHAR(20) NOT NULL, -- 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'
                start_date DATE NOT NULL,
                next_run_date DATE NOT NULL,
                status VARCHAR(20) DEFAULT 'active', -- 'active', 'paused', 'cancelled'
                created_by VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_recurring_expenses_store ON recurring_expenses(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_recurring_expenses_next_run ON recurring_expenses(next_run_date);`);

        // --- Sales documents: customer quotations & invoices ---
        //
        // These are *documents*, not a second revenue path. A sale remains the
        // only thing that posts revenue/tax/COGS and moves stock; a document
        // records what was offered or billed, and links to the sale it became
        // via `converted_sale_id`. That keeps one definition of revenue across
        // the reports (see accounting.service.recordSale).
        await client.query(`
            CREATE TABLE IF NOT EXISTS sales_documents (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL,
                doc_type TEXT NOT NULL CHECK (doc_type IN ('quotation','invoice')),
                number TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','sent','accepted','declined','expired','converted','cancelled')),
                customer_id TEXT REFERENCES customers(id),
                customer_name TEXT NOT NULL,
                customer_phone TEXT,
                customer_email TEXT,
                customer_address TEXT,
                issue_date DATE NOT NULL,
                -- Quotations expire; invoices fall due. One column, meaning set
                -- by doc_type, so "what date matters" is never ambiguous.
                valid_until DATE,
                subtotal DECIMAL(12,2) NOT NULL DEFAULT 0,
                discount DECIMAL(12,2) NOT NULL DEFAULT 0,
                tax DECIMAL(12,2) NOT NULL DEFAULT 0,
                tax_rate DECIMAL(6,4) NOT NULL DEFAULT 0,
                total DECIMAL(12,2) NOT NULL DEFAULT 0,
                notes TEXT,
                terms TEXT,
                source_document_id TEXT REFERENCES sales_documents(id),
                converted_sale_id TEXT,
                converted_at TIMESTAMPTZ,
                created_by TEXT NOT NULL,
                created_by_name TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        // Document numbers are per store and per type (QUO-0001 / INV-0001).
        await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_documents_number ON sales_documents(store_id, doc_type, number);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_documents_store_type ON sales_documents(store_id, doc_type, status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_documents_customer ON sales_documents(store_id, customer_id);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS sales_document_items (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES sales_documents(id) ON DELETE CASCADE,
                store_id TEXT NOT NULL,
                -- Nullable: a quote may list something not yet in the catalogue.
                product_id TEXT,
                name TEXT NOT NULL,
                sku TEXT,
                quantity DECIMAL(12,3) NOT NULL,
                unit_price DECIMAL(12,2) NOT NULL,
                line_total DECIMAL(12,2) NOT NULL,
                position INTEGER NOT NULL DEFAULT 0
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_sales_document_items_doc ON sales_document_items(document_id);`);

        // Manual receipts and delivery notes — the paper books a shop keeps on the
        // counter, issued from the app so they carry the same numbering, branding
        // and TPIN. Like quotations and invoices these are *documents*: a receipt
        // here records that a payment was acknowledged, it does not post to the
        // ledger (the sale/payment does), so the books can't be double-counted.
        await client.query(`
            DO $$
            BEGIN
                ALTER TABLE sales_documents DROP CONSTRAINT IF EXISTS sales_documents_doc_type_check;
                ALTER TABLE sales_documents ADD CONSTRAINT sales_documents_doc_type_check
                    CHECK (doc_type IN ('quotation','invoice','delivery_note','receipt'));
            EXCEPTION WHEN others THEN
                RAISE WARNING 'Could not widen sales_documents.doc_type: %', SQLERRM;
            END $$;
        `);
        // Receipt specifics (how the money arrived) and delivery-note specifics
        // (who handed over, who signed for it).
        await client.query(`ALTER TABLE sales_documents ADD COLUMN IF NOT EXISTS payment_method TEXT;`);
        await client.query(`ALTER TABLE sales_documents ADD COLUMN IF NOT EXISTS payment_reference TEXT;`);
        await client.query(`ALTER TABLE sales_documents ADD COLUMN IF NOT EXISTS delivered_by TEXT;`);
        await client.query(`ALTER TABLE sales_documents ADD COLUMN IF NOT EXISTS received_by TEXT;`);

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

        // Add created_at to products table if missing (some queries rely on it for ordering)
        await client.query(`
            ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_products_store_id_created_at ON products(store_id, created_at);`);

        // Add created_at to sale_items table if missing (for backward compat - canonical date is sales.timestamp)
        await client.query(`
            ALTER TABLE sale_items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
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

        // Notifications Table (targeted)
        await client.query(`
            CREATE TABLE IF NOT EXISTS notifications (
                id TEXT PRIMARY KEY,
                store_id TEXT REFERENCES stores(id),
                user_id TEXT REFERENCES users(id),
                title TEXT NOT NULL,
                message TEXT NOT NULL,
                type TEXT DEFAULT 'info',
                is_read BOOLEAN DEFAULT FALSE,
                link TEXT,
                reference_id TEXT, -- ID of related entity, e.g. system_notification.id
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        // Migration to add reference_id if missing
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'notifications') THEN
                    ALTER TABLE notifications ADD COLUMN IF NOT EXISTS reference_id TEXT;
                    CREATE INDEX IF NOT EXISTS idx_notifications_reference_id ON notifications(reference_id);
                END IF;
            END $$;
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_store_id ON notifications(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);`);

        // Marketplace Tables
        await client.query(`
            CREATE TABLE IF NOT EXISTS marketplace_requests (
                id TEXT PRIMARY KEY,
                customer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
                customer_name TEXT NOT NULL,
                customer_email TEXT,
                customer_phone TEXT,
                query TEXT NOT NULL,
                target_price DECIMAL(10, 2) NOT NULL,
                status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'matched', 'completed', 'cancelled')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_requests_status ON marketplace_requests(status);`);

        // Migration for marketplace_requests
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'marketplace_requests') THEN
                    ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS customer_phone TEXT;
                    ALTER TABLE marketplace_requests ADD COLUMN IF NOT EXISTS customer_id TEXT REFERENCES users(id) ON DELETE SET NULL;
                    ALTER TABLE marketplace_requests ALTER COLUMN customer_email DROP NOT NULL;
                END IF;
            END $$;
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS marketplace_matches (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
                store_id TEXT NOT NULL REFERENCES stores(id),
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'notified', 'offered', 'declined', 'skipped')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_matches_request_id ON marketplace_matches(request_id);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS marketplace_offers (
                id TEXT PRIMARY KEY,
                request_id TEXT NOT NULL REFERENCES marketplace_requests(id) ON DELETE CASCADE,
                match_id TEXT REFERENCES marketplace_matches(id),
                store_id TEXT NOT NULL REFERENCES stores(id),
                product_id TEXT REFERENCES products(id),
                seller_price DECIMAL(10, 2) NOT NULL,
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_offers_request_id ON marketplace_offers(request_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_marketplace_offers_store_id ON marketplace_offers(store_id);`);

        // Push Subscriptions Table
        await client.query(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id TEXT PRIMARY KEY,
                user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
                endpoint TEXT UNIQUE NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);`);

        // Migration to make p256dh and auth nullable for FCM
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'push_subscriptions') THEN
                    ALTER TABLE push_subscriptions ALTER COLUMN p256dh DROP NOT NULL;
                    ALTER TABLE push_subscriptions ALTER COLUMN auth DROP NOT NULL;
                END IF;
            END $$;
        `);


        // Logistics (Couriers & Shipments)
        // Logistics (Couriers, Buses, Shipments)
        await client.query(`
            CREATE TABLE IF NOT EXISTS couriers (
                id TEXT PRIMARY KEY,
                company_name TEXT NOT NULL,
                contact_details TEXT, -- phone/email
                receipt_details TEXT, -- account info etc?
                is_active BOOLEAN DEFAULT TRUE,
                store_id TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_couriers_store_id ON couriers(store_id);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS buses (
                id TEXT PRIMARY KEY,
                driver_name TEXT NOT NULL,
                vehicle_name TEXT,
                number_plate TEXT NOT NULL,
                contact_phone TEXT,
                is_active BOOLEAN DEFAULT TRUE,
                store_id TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_buses_store_id ON buses(store_id);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS shipments (
                id TEXT PRIMARY KEY,
                tracking_number TEXT NOT NULL,
                method TEXT NOT NULL CHECK (method IN ('courier', 'bus')),
                courier_id TEXT REFERENCES couriers(id),
                bus_id TEXT REFERENCES buses(id),
                sale_id TEXT REFERENCES sales(transaction_id),
                status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'shipped', 'in_transit', 'delivered', 'failed', 'returned')),
                recipient_name TEXT,
                recipient_phone TEXT,
                recipient_address TEXT,
                destination TEXT,
                shipping_cost DECIMAL(10,2) NOT NULL DEFAULT 0,
                image_urls TEXT[],
                notes TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                store_id TEXT
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_store_id ON shipments(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_tracking_number ON shipments(tracking_number);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_shipments_sale_id ON shipments(sale_id);`);
        // Migrations to support previous schema (drop old columns or tables if empty?)
        // For dev environment, we assume we can just ensure new tables.
        // If old 'couriers' table exists with different columns, we might need a migration DO block.
        await client.query(`
            DO $$
            BEGIN
                -- Migration for couriers table if it exists from previous version (rename/add columns)
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'couriers') THEN
                    -- Check if 'company_name' exists, if not, it might be the old schema
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'company_name') THEN
                        -- Rename name to company_name
                        ALTER TABLE couriers RENAME COLUMN name TO company_name;
                    END IF;
                    -- Add new columns if missing
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'receipt_details') THEN
                        ALTER TABLE couriers ADD COLUMN receipt_details TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'contact_details') THEN
                        ALTER TABLE couriers ADD COLUMN contact_details TEXT;
                    END IF;
                    -- Drop old columns that are no longer needed
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'type') THEN
                        ALTER TABLE couriers DROP COLUMN type;
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'contact_person') THEN
                        ALTER TABLE couriers DROP COLUMN contact_person;
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'phone') THEN
                        ALTER TABLE couriers DROP COLUMN phone;
                    END IF;
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'email') THEN
                        ALTER TABLE couriers DROP COLUMN email;
                    END IF;
                    -- Add timestamp columns if missing
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'created_at') THEN
                        ALTER TABLE couriers ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'couriers' AND column_name = 'updated_at') THEN
                        ALTER TABLE couriers ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
                    END IF;
                END IF;

                -- Add timestamp columns to buses if missing
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'buses') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'buses' AND column_name = 'created_at') THEN
                        ALTER TABLE buses ADD COLUMN created_at TIMESTAMPTZ DEFAULT NOW();
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'buses' AND column_name = 'updated_at') THEN
                        ALTER TABLE buses ADD COLUMN updated_at TIMESTAMPTZ DEFAULT NOW();
                    END IF;
                END IF;

                -- Migration for shipments table
                 IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'shipments') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'method') THEN
                        ALTER TABLE shipments ADD COLUMN method TEXT CHECK (method IN ('courier', 'bus'));
                        UPDATE shipments SET method = 'courier' WHERE method IS NULL;
                        ALTER TABLE shipments ALTER COLUMN method SET NOT NULL;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'bus_id') THEN
                        ALTER TABLE shipments ADD COLUMN bus_id TEXT REFERENCES buses(id);
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'destination') THEN
                        ALTER TABLE shipments ADD COLUMN destination TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'recipient_name') THEN
                        ALTER TABLE shipments ADD COLUMN recipient_name TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'recipient_phone') THEN
                        ALTER TABLE shipments ADD COLUMN recipient_phone TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'recipient_address') THEN
                        ALTER TABLE shipments ADD COLUMN recipient_address TEXT;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'image_urls') THEN
                        ALTER TABLE shipments ADD COLUMN image_urls TEXT[];
                    END IF;
                    -- Drop legacy recipient_details column if it exists (replaced by individual columns)
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'recipient_details') THEN
                        ALTER TABLE shipments DROP COLUMN recipient_details;
                    END IF;
                    -- Drop legacy sender_details column if it exists
                    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'shipments' AND column_name = 'sender_details') THEN
                        ALTER TABLE shipments DROP COLUMN sender_details;
                    END IF;
                 END IF;

                 -- Migration for returns: Add returned_quantity to sale_items if missing
                 IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'sale_items') THEN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'sale_items' AND column_name = 'returned_quantity') THEN
                        ALTER TABLE sale_items ADD COLUMN returned_quantity DECIMAL(10,3) NOT NULL DEFAULT 0;
                    END IF;
                 END IF;
            END $$;
        `);

        console.log('✅ Logistics tables (couriers, buses, shipments) verified/created');

        console.log('✅ Logistics tables (couriers, shipments) verified/created');

        // WhatsApp Integration Tables
        await client.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_config (
                store_id TEXT PRIMARY KEY REFERENCES stores(id),
                phone_number_id TEXT NOT NULL,
                access_token TEXT NOT NULL,  -- Encrypted
                business_account_id TEXT,
                webhook_verify_token TEXT NOT NULL,
                is_enabled BOOLEAN DEFAULT FALSE,
                auto_reply_enabled BOOLEAN DEFAULT TRUE,
                business_hours JSONB,
                away_message TEXT,
                greeting_message TEXT,
                display_phone_number TEXT,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        // Older deployments created whatsapp_config before display_phone_number existed.
        await client.query(`ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS display_phone_number TEXT;`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_conversations (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL REFERENCES stores(id),
                customer_phone TEXT NOT NULL,
                customer_name TEXT,
                customer_id TEXT REFERENCES customers(id),
                status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'escalated')),
                last_message_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                metadata JSONB
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_store_id ON whatsapp_conversations(store_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_phone ON whatsapp_conversations(customer_phone);`);

        await client.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL REFERENCES whatsapp_conversations(id) ON DELETE CASCADE,
                store_id TEXT NOT NULL,
                direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
                message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'document', 'interactive', 'template')),
                content TEXT,
                media_url TEXT,
                whatsapp_message_id TEXT,
                status TEXT DEFAULT 'sent' CHECK (status IN ('sent', 'delivered', 'read', 'failed')),
                is_ai_generated BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_conversation_id ON whatsapp_messages(conversation_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_store_id ON whatsapp_messages(store_id);`);

        // WhatsApp marketing campaigns (scheduled / recurring / triggered automations).
        await client.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_campaigns (
                id TEXT PRIMARY KEY,
                store_id TEXT NOT NULL,
                name TEXT NOT NULL,
                type TEXT NOT NULL DEFAULT 'one_off' CHECK (type IN ('one_off','recurring','trigger')),
                status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','active','paused','completed','cancelled')),
                segment TEXT NOT NULL DEFAULT 'all',
                segment_params JSONB,
                message_mode TEXT NOT NULL DEFAULT 'text' CHECK (message_mode IN ('text','template')),
                message_text TEXT,
                template_name TEXT,
                template_lang TEXT DEFAULT 'en_US',
                template_params JSONB,
                scheduled_at TIMESTAMPTZ,
                recurrence TEXT,
                trigger_event TEXT,
                trigger_params JSONB,
                last_run_at TIMESTAMPTZ,
                next_run_at TIMESTAMPTZ,
                sent_count INT NOT NULL DEFAULT 0,
                created_by TEXT,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_wa_campaigns_store ON whatsapp_campaigns(store_id);`);
        await client.query(`
            CREATE TABLE IF NOT EXISTS whatsapp_campaign_sends (
                id TEXT PRIMARY KEY,
                campaign_id TEXT NOT NULL REFERENCES whatsapp_campaigns(id) ON DELETE CASCADE,
                store_id TEXT NOT NULL,
                customer_id TEXT,
                phone TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'sent',
                error TEXT,
                sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_wa_campaign_sends_lookup ON whatsapp_campaign_sends(campaign_id, customer_id);`);

        // Facebook Page connection for the Social Marketing suite (one Page per store).
        await client.query(`
            CREATE TABLE IF NOT EXISTS facebook_config (
                store_id TEXT PRIMARY KEY REFERENCES stores(id),
                page_id TEXT,
                page_name TEXT,
                page_access_token TEXT,        -- Encrypted (long-lived Page token)
                user_access_token TEXT,        -- Encrypted (long-lived user token)
                instagram_business_id TEXT,
                is_enabled BOOLEAN DEFAULT TRUE,
                connected_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ DEFAULT NOW(),
                updated_at TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE TABLE IF NOT EXISTS ai_usage_logs (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                store_id TEXT NOT NULL,
                user_id TEXT NOT NULL,
                feature TEXT NOT NULL,
                request_payload JSONB,
                response_summary TEXT,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                month_year TEXT NOT NULL
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_usage_store_month ON ai_usage_logs(store_id, month_year);`);

        console.log('✅ AI usage logs tables verified/created');
        console.log('✅ WhatsApp integration tables verified/created');

        // Idempotency keys — lets offline-capable clients (web/desktop/mobile)
        // safely retry queued writes via the X-Idempotency-Key header without
        // creating duplicate sales/products. See middleware/idempotency.middleware.ts.
        await client.query(`
            CREATE TABLE IF NOT EXISTS idempotency_keys (
                key TEXT PRIMARY KEY,
                user_id TEXT,
                method TEXT NOT NULL,
                path TEXT,
                status_code INT,
                response_body JSONB,
                created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_idempotency_created_at ON idempotency_keys(created_at);`);
        console.log('✅ Idempotency keys table verified/created');

        // User feedback — collected in-app from any authenticated user (store
        // owners, staff, customers) and triaged from the Super Admin console.
        // Intentionally NOT foreign-keyed to users/stores: feedback must always
        // persist even if the author or their store is later deleted, and it is
        // never tenant-scoped for reads (only the platform owner sees it).
        await client.query(`
            CREATE TABLE IF NOT EXISTS feedback (
                id TEXT PRIMARY KEY,
                store_id TEXT,
                store_name TEXT,
                user_id TEXT,
                user_name TEXT,
                user_email TEXT,
                user_role TEXT,
                type TEXT NOT NULL DEFAULT 'general' CHECK (type IN ('bug','feature','improvement','praise','general')),
                rating INT CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
                subject TEXT,
                message TEXT NOT NULL,
                page TEXT,
                app_version TEXT,
                platform TEXT,
                status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','reviewing','planned','resolved','dismissed')),
                admin_notes TEXT,
                resolved_by TEXT,
                resolved_at TIMESTAMPTZ,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );
        `);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_feedback_created_at ON feedback(created_at DESC);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_feedback_status ON feedback(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_feedback_type ON feedback(type);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_feedback_store_id ON feedback(store_id);`);
        console.log('✅ Feedback table verified/created');

        console.log('✅ Database schema verified/updated successfully');
    } catch (error) {
        console.error('❌ Error initializing database:', error);
    } finally {
        client.release(); // Release the client back to the pool, but don't end the pool
    }
}

export default initializeDatabase;

