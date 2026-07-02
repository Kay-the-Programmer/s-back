import db from '../db_client';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Resync the platform super-admin account with the values in the environment.
 *
 * The super-admin is seeded ONCE in init_db.ts (only when missing), so a later
 * change to SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD never reaches an account that
 * already exists — which locks you out with a stale password. This script is the
 * escape hatch: it (re)sets the super-admin's password to SUPERADMIN_PASSWORD,
 * creating the account if it isn't there yet.
 *
 * Run: `npm run superadmin:reset`
 */
async function resetSuperadmin() {
    const email = (process.env.SUPERADMIN_EMAIL || 'superadmin@sale-pilot.com').toLowerCase();
    const password = process.env.SUPERADMIN_PASSWORD || 'password';

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);

    if (existing.rowCount && existing.rowCount > 0) {
        await db.query(
            `UPDATE users
                SET password_hash = $1,
                    role = 'superadmin',
                    is_verified = TRUE
              WHERE email = $2`,
            [passwordHash, email]
        );
        console.log(`✅ Super-admin password reset for ${email}`);
    } else {
        await db.query(
            `INSERT INTO users (id, name, email, password_hash, role, is_verified)
             VALUES ('user_superadmin_default', 'Super Admin', $1, $2, 'superadmin', TRUE)`,
            [email, passwordHash]
        );
        console.log(`✅ Super-admin created: ${email}`);
    }

    console.log(`   You can now log in with:  ${email}  /  ${password}`);
    await (db as any)._pool.end();
}

resetSuperadmin().catch(err => {
    console.error('❌ Failed to reset super-admin:', err);
    process.exit(1);
});
