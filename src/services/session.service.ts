import db from '../db_client';
import { invalidateUserCache } from '../middleware/auth.middleware';

/**
 * Session revocation.
 *
 * Access tokens live for 30 days and are self-contained, so until now nothing
 * could take one back: a password change left old sessions signed in, a
 * demotion left the old role usable, and a stolen token was good for a month.
 * Each token now carries the `token_version` its user had when it was signed,
 * and bumping that column strands every token already issued.
 *
 * Why the 30-day lifetime stays: the desktop till and the mobile apps are
 * offline-first and are expected to go a long time between reaching the
 * server, so shortening expiry (or requiring a refresh round-trip) would sign
 * out a shop that is merely off the network. Revocation gives us the control
 * that short expiry was standing in for, without that cost.
 */

/**
 * Invalidate every token already issued for a user.
 *
 * The cache eviction is not optional. `protect` reads token_version from the
 * same cached user row it reads `role` from, so a bump that left a stale row
 * in place would be compared against the stale version and pass — the user
 * would keep their access for the rest of the TTL. Both must move together,
 * which is the whole reason this lives in one function instead of at each
 * call site.
 *
 * Pass `client` to enlist in an open transaction; the cache is evicted either
 * way. Note the cache is per-process: should this ever run as more than one
 * container, the eviction reaches only the instance that handled the request
 * and the others keep serving the old row until their TTL expires. Dropping
 * AUTH_USER_CACHE_TTL_MS to 0 disables caching entirely if that day comes.
 */
export const revokeUserSessions = async (userId: string, client?: { query: Function }): Promise<number> => {
    const runner = client ?? db;
    const result = await runner.query(
        'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
        [userId]
    );
    invalidateUserCache(userId);
    return result.rows[0]?.token_version ?? 0;
};

/**
 * Read a user's current token_version, for signing a fresh token right after
 * revoking the old ones (otherwise the new token is stranded too).
 */
export const currentTokenVersion = async (userId: string): Promise<number> => {
    const result = await db.query('SELECT token_version FROM users WHERE id = $1', [userId]);
    return result.rows[0]?.token_version ?? 0;
};
