import { Pool, types } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// NUMERIC/DECIMAL (OID 1700) arrives as a string by default. Every money column
// (sales.subtotal, accounts.balance, …) is NUMERIC, and consumers sum these values
// with `+` — with strings that concatenates instead of adds, silently corrupting
// report totals. Parse to number at the driver boundary so the whole API serves
// real numbers.
types.setTypeParser(1700, (v: string) => parseFloat(v));

// DATE (OID 1082) is a calendar day, not an instant — an invoice due on the 11th
// is due on the 11th in every timezone. The driver's default turns it into a JS
// Date at the SERVER's local midnight, which then serialises to an instant and
// lands on the previous day for any client behind the server. Handing back the
// raw `YYYY-MM-DD` keeps a date a date, and lets `toCamelCase` tell it apart
// from a real timestamp — the column type is the only place that distinction
// survives, since `date` is a DATE on expenses but a timestamptz on payments.
types.setTypeParser(1082, (v: string) => v);

// SSL when explicitly requested (DB_SSL=true, e.g. managed Postgres), or in
// production UNLESS explicitly disabled (DB_SSL=false — e.g. a containerized
// Postgres on the same host, which has no SSL support).
const useSsl = process.env.DB_SSL === 'true'
    || (process.env.NODE_ENV === 'production' && process.env.DB_SSL !== 'false');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
});

// A dropped/errored idle client emits 'error' on the pool; without a handler
// Node treats it as an uncaught exception and crashes the whole process.
pool.on('error', (err) => {
    console.error('[db] Unexpected error on idle client:', err.message);
});

export default {
    query: (text: string, params?: any[]) => pool.query(text, params),
    // Expose the pool for scripts like seeding to manage connection lifecycle
    _pool: pool,
};