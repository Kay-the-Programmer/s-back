import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const isProduction = process.env.NODE_ENV === 'production' || process.env.DB_SSL === 'true';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: isProduction ? { rejectUnauthorized: false } : undefined,
});

export default {
    query: (text: string, params?: any[]) => pool.query(text, params),
    // Expose the pool for scripts like seeding to manage connection lifecycle
    _pool: pool,
};