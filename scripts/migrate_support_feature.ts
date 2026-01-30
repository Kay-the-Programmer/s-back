
import db from '../src/db_client';

async function migrate() {
    console.log('--- Migrating Database for Store Owner Support ---');

    // 1. Create System Store if not exists
    await db.query(`
        INSERT INTO stores (id, name, status, subscription_status)
        VALUES ('system', 'SalePilot System', 'active', 'active')
        ON CONFLICT (id) DO NOTHING
    `);
    console.log('✅ System store ensured');

    // 2. Add display_phone_number to whatsapp_config
    try {
        await db.query(`
            ALTER TABLE whatsapp_config 
            ADD COLUMN IF NOT EXISTS display_phone_number TEXT
        `);
        console.log('✅ Added display_phone_number column');
    } catch (e) {
        console.log('⚠️ Column might already exist or error:', e);
    }

    // 3. Insert system whatsapp_config for support contact
    await db.query(`
        INSERT INTO whatsapp_config (store_id, display_phone_number, greeting_message, is_enabled)
        VALUES ('system', '+1234567890', 'Hello! Welcome to SalePilot Support. How can we help you today?', true)
        ON CONFLICT (store_id) DO NOTHING
    `);
    console.log('✅ System whatsapp_config ensured');

    process.exit(0);
}

migrate().catch(console.error);
