import bcrypt from 'bcryptjs';
import db from '../db_client';
import { generateId } from '../utils/helpers';
import { roleHasPermission, Role } from '../auth/rbac';
import {
    OVERRIDE_TTL_SECONDS,
    OverrideAction,
    OverrideThresholds,
    parseThresholds,
} from './override-rules';

export { parseThresholds } from './override-rules';

/**
 * Granting and spending manager authorisations.
 *
 * The rules about when one is needed live in ./override-rules, which imports no
 * database. This file is the part that touches one.
 */

export interface GrantedOverride {
    id: string;
    authorizedBy: string;
    expiresAt: Date;
}

/** The store's limits, or empty when it has never set any. */
export const loadThresholds = async (storeId: string): Promise<OverrideThresholds> => {
    try {
        const { rows } = await db.query(
            'SELECT override_thresholds FROM store_settings WHERE store_id = $1',
            [storeId],
        );
        return parseThresholds(rows[0]?.override_thresholds);
    } catch {
        // A store with no settings row has no limits, which means no overrides
        // are demanded — never the other way round. A lookup failure must not
        // be able to stop a shop trading.
        return parseThresholds(null);
    }
};

/**
 * Find the manager behind a PIN.
 *
 * Compared against every eligible user in the store because a bcrypt hash
 * cannot be looked up by value. That is only tolerable while the number of
 * managers is small and attempts are rate-limited, which is why the caller does
 * both.
 */
export const managerForPin = async (
    storeId: string,
    pin: string,
): Promise<{ id: string; name: string } | null> => {
    const { rows } = await db.query(
        `SELECT u.id, u.name, u.role, u.manager_pin_hash
           FROM users u
          WHERE u.current_store_id = $1 AND u.manager_pin_hash IS NOT NULL`,
        [storeId],
    );
    for (const row of rows) {
        if (!roleHasPermission(row.role as Role, 'override:authorize')) continue;
        // Every candidate is compared even after a match would have been found,
        // so the time taken does not reveal how many managers a store has.
        if (bcrypt.compareSync(pin, row.manager_pin_hash)) {
            return { id: String(row.id), name: String(row.name) };
        }
    }
    return null;
};

/** Record a manager's decision, good for one use and a few minutes. */
export const grantOverride = async (params: {
    storeId: string;
    action: OverrideAction;
    maxAmount: number | null;
    authorizedBy: { id: string; name: string };
    requestedBy?: { id?: string; name?: string };
    reason?: string;
}): Promise<GrantedOverride> => {
    const id = generateId('OVR');
    const { rows } = await db.query(
        `INSERT INTO override_authorizations
            (id, store_id, action, max_amount, authorized_by, authorized_by_id,
             requested_by, requested_by_id, reason, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW() + ($10 || ' seconds')::interval)
         RETURNING expires_at`,
        [
            id, params.storeId, params.action, params.maxAmount,
            params.authorizedBy.name, params.authorizedBy.id,
            params.requestedBy?.name ?? null, params.requestedBy?.id ?? null,
            (params.reason ?? '').trim().slice(0, 300) || null,
            String(OVERRIDE_TTL_SECONDS),
        ],
    );
    return { id, authorizedBy: params.authorizedBy.name, expiresAt: rows[0].expires_at };
};

export class OverrideError extends Error {}

/**
 * Spend an authorisation, or explain why it cannot be spent.
 *
 * The UPDATE carries every condition — unused, unexpired, right store, right
 * action — so redeeming is a single atomic statement. Checking first and
 * updating after would let the same code be spent twice by two requests
 * arriving together, which is precisely the hole an override is meant to close.
 */
export const consumeOverride = async (params: {
    overrideId: unknown;
    storeId: string;
    action: OverrideAction;
    amount: number;
}): Promise<{ authorizedBy: string }> => {
    const id = typeof params.overrideId === 'string' ? params.overrideId.trim() : '';
    if (!id) {
        throw new OverrideError('This needs a manager\'s approval.');
    }

    const { rows } = await db.query(
        `UPDATE override_authorizations
            SET used_at = NOW()
          WHERE id = $1
            AND store_id = $2
            AND action = $3
            AND used_at IS NULL
            AND expires_at > NOW()
            AND (max_amount IS NULL OR $4::numeric <= max_amount)
          RETURNING authorized_by`,
        [id, params.storeId, params.action, params.amount],
    );
    if (!rows.length) {
        // Deliberately one message for every failure. Telling a cashier whether
        // a code was expired, already spent, or for a smaller amount tells
        // anyone probing the same thing.
        throw new OverrideError('That approval is not valid for this. Ask a manager again.');
    }
    return { authorizedBy: String(rows[0].authorized_by) };
};

/**
 * Whether this user can simply do the thing themselves.
 *
 * A manager working the till holds the permission already, and making them
 * approve their own action would be theatre — and would train everyone to treat
 * the prompt as noise.
 */
export const canSelfAuthorize = (role: unknown): boolean =>
    roleHasPermission(role as Role, 'override:authorize');
