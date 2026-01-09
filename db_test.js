const { Pool } = require('pg');
require('dotenv').config();
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ DB connection failed:', err.message);
    } else {
        console.log('✅ DB connection successful:', res.rows[0].now);
    }
    pool.end();
});
