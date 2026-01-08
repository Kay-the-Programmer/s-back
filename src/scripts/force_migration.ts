
import db from '../db_client';

async function forceMigration() {
    const client = await (db as any)._pool.connect();
    try {
        console.log("Starting manual migration...");
        await client.query('BEGIN');

        console.log("Adding 'reference' column to 'payments' table if it doesn't exist...");
        await client.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'payments') THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM information_schema.columns 
                        WHERE table_name = 'payments' AND column_name = 'reference'
                    ) THEN
                        ALTER TABLE payments ADD COLUMN reference TEXT;
                        RAISE NOTICE 'Added reference column to payments table';
                    ELSE
                        RAISE NOTICE 'Reference column already exists in payments table';
                    END IF;
                END IF;
            END $$;
        `);

        await client.query('COMMIT');
        console.log("Migration completed successfully.");
    } catch (e) {
        await client.query('ROLLBACK');
        console.error("Migration failed:", e);
    } finally {
        client.release();
        process.exit();
    }
}

forceMigration();
