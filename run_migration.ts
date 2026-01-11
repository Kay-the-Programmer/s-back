
import initializeDatabase from './src/init_db';
import dotenv from 'dotenv';
dotenv.config();

console.log('Starting migration...');
initializeDatabase().then(() => {
    console.log('Migration completed.');
    process.exit(0);
}).catch((err) => {
    console.error('Migration failed:', err);
    process.exit(1);
});
