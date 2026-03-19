import db from './db_client';
import initializeDatabase from './init_db';
import seedDatabase from './seed';
import dotenv from 'dotenv';

dotenv.config();

async function resetDatabase() {
    console.log('⚠️  WARNING: RESETTING DATABASE. ALL DATA WILL BE LOST. ⚠️');

    // Give a small delay to allow user to cancel if running from terminal (though this is automated here)
    // In a real CLI we might use readline, but for this agent context we proceed.

    const client = await (db as any)._pool.connect();

    try {
        console.log('--- Dropping Schema ---');
        await client.query('DROP SCHEMA public CASCADE');
        await client.query('CREATE SCHEMA public');
        await client.query('GRANT ALL ON SCHEMA public TO public'); // Ensure permissions are restored
        console.log('✅ Public schema dropped and recreated.');

        console.log('--- Initializing Empty Schema ---');
        await initializeDatabase();
        console.log('✅ Schema initialized successfully.');

        console.log('--- Seeding Default Data ---');
        await seedDatabase();
        console.log('✅ Database seeded successfully.');

        console.log('\n✨ Database reset completed successfully! ✨');
    } catch (error) {
        console.error('❌ Error during database reset:', error);
        process.exit(1);
    } finally {
        client.release();
        await (db as any)._pool.end();
        process.exit(0);
    }
}

resetDatabase();
