import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// SSL when explicitly requested (DB_SSL=true, e.g. managed Postgres), or in
// production UNLESS explicitly disabled (DB_SSL=false — e.g. a containerized
// Postgres on the same host, which has no SSL support).
const useSsl = process.env.DB_SSL === 'true'
    || (process.env.NODE_ENV === 'production' && process.env.DB_SSL !== 'false');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

export default {
    query: (text: string, params?: any[]) => pool.query(text, params),
    // Expose the pool for scripts like seeding to manage connection lifecycle
    _pool: pool,
};