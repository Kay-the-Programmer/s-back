import db from '../src/db_client';
import fs from 'fs';

async function verifyAndFix() {
    const logs: string[] = [];
    const log = (msg: string) => {
        console.log(msg);
        logs.push(msg);
    };

    log('--- Verifying System Support Config ---');

    try {
        // 1. Check if system store exists
        const storeCheck = await db.query("SELECT * FROM stores WHERE id = 'system'");
        if (storeCheck.rows.length === 0) {
            log('❌ System store missing. Inserting...');
            await db.query(`
                INSERT INTO stores (id, name, status, subscription_status)
                VALUES ('system', 'SalePilot System', 'active', 'active')
            `);
            log('✅ System store created.');
        } else {
            log('✅ System store exists.');
        }

        // 2. Check if whatsapp_config for system exists
        const configCheck = await db.query("SELECT * FROM whatsapp_config WHERE store_id = 'system'");
        if (configCheck.rows.length === 0) {
            log('❌ System whatsapp_config missing. Inserting...');
            await db.query(`
                INSERT INTO whatsapp_config (
                    store_id, 
                    display_phone_number, 
                    greeting_message, 
                    is_enabled,
                    phone_number_id,
                    access_token,
                    business_account_id,
                    webhook_verify_token
                )
                VALUES (
                    'system', 
                    '+1234567890', 
                    'Hello! Welcome to SalePilot Support. How can we help you today?', 
                    true,
                    'system_dummy_id',
                    'system_dummy_token',
                    'system_dummy_biz_id',
                    'system_dummy_verify_token'
                )
            `);
            log('✅ System whatsapp_config created.');
        } else {
            log('✅ System whatsapp_config exists.');
            log(`Current Config: ${JSON.stringify(configCheck.rows[0])}`);
        }

    } catch (error) {
        log(`Error during verification: ${error}`);
    } finally {
        fs.writeFileSync('verification_result.txt', logs.join('\n'));
        process.exit(0);
    }
}

verifyAndFix();
