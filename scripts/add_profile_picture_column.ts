import db from '../src/db_client';

async function migrate() {
    console.log('Adding profile_picture column to users table...');
    try {
        await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_picture TEXT;`);
        console.log('Successfully added profile_picture column to users table.');
        process.exit(0);
    } catch (error) {
        console.error('Error modifying users table:', error);
        process.exit(1);
    }
}

migrate();
