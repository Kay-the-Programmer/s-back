import express from 'express';
import db from '../db_client';
import { User } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { invalidateUserCache } from '../middleware/auth.middleware';
import { MODULES, FREE_SEATS, isModuleEnabled } from '../services/entitlements.service';
import bcrypt from 'bcryptjs';

// Helper: determine if requester is superadmin
function isSuperAdmin(req: express.Request): boolean {
    return req.user?.role === 'superadmin';
}

export const getUsers = async (req: express.Request, res: express.Response) => {
    try {
        if (isSuperAdmin(req)) {
            // Superadmin can see all users (optionally filter by store via query.currentStoreId)
            const { currentStoreId } = (req.query || {}) as { currentStoreId?: string };
            if (currentStoreId) {
                const result = await db.query('SELECT id, name, email, role, is_verified FROM users WHERE current_store_id = $1 ORDER BY name', [currentStoreId]);
                return res.status(200).json(toCamelCase(result.rows));
            }
            const result = await db.query('SELECT id, name, email, role, is_verified FROM users ORDER BY name');
            return res.status(200).json(toCamelCase(result.rows));
        }

        // Non-superadmin: must have a current store, and only see users from same store
        const storeId = req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'No store selected. Set current store to manage users.' });
        }
        const result = await db.query('SELECT id, name, email, role FROM users WHERE current_store_id = $1 ORDER BY name', [storeId]);
        return res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching users:', error);
        res.status(500).json({ message: 'Error fetching users' });
    }
};

export const getUserById = async (req: express.Request, res: express.Response) => {
    try {
        if (isSuperAdmin(req)) {
            const result = await db.query('SELECT id, name, email, role, is_verified FROM users WHERE id = $1', [req.params.id]);
            if ((result.rowCount ?? 0) === 0) {
                return res.status(404).json({ message: 'User not found' });
            }
            return res.status(200).json(toCamelCase(result.rows[0]));
        }
        const storeId = req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'No store selected. Set current store to manage users.' });
        }
        const result = await db.query('SELECT id, name, email, role, is_verified FROM users WHERE id = $1 AND current_store_id = $2', [req.params.id, storeId]);
        if ((result.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        return res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error(`Error fetching user ${req.params.id}:`, error);
        res.status(500).json({ message: 'Error fetching user' });
    }
};

/**
 * Roles a STORE admin may hand out. Deliberately excludes `superadmin`: these
 * routes are admin-gated, and without this list any store owner could POST
 * `role: 'superadmin'` and mint themselves a platform operator with access to
 * every store on the system. `customer` and `supplier` are self-service account
 * types created by their own sign-up flows, not by team management.
 */
const STORE_ASSIGNABLE_ROLES = ['admin', 'staff', 'inventory_manager'] as const;

/** Null when the requester may assign this role, else the reason they can't. */
const roleAssignmentError = (req: express.Request, role: unknown): string | null => {
    const value = String(role || '');
    if (isSuperAdmin(req)) {
        // The platform operator may set any role the schema allows.
        return ['superadmin', ...STORE_ASSIGNABLE_ROLES, 'customer', 'supplier'].includes(value)
            ? null
            : `Unknown role: ${value}`;
    }
    return (STORE_ASSIGNABLE_ROLES as readonly string[]).includes(value)
        ? null
        : `Role must be one of: ${STORE_ASSIGNABLE_ROLES.join(', ')}`;
};

export const createUser = async (req: express.Request, res: express.Response) => {
    const requester = req.user!;
    const { name, email, role, password, currentStoreId } = req.body || {};
    if (!name || !email || !role || !password) {
        return res.status(400).json({ message: 'Name, email, role, and password are required' });
    }
    const roleError = roleAssignmentError(req, role);
    if (roleError) {
        return res.status(403).json({ message: roleError });
    }

    try {
        const userExists = await db.query('SELECT id FROM users WHERE email = $1', [String(email).toLowerCase()]);
        if ((userExists.rowCount ?? 0) > 0) {
            return res.status(400).json({ message: 'Email is already in use' });
        }

        // Determine store assignment
        let targetStoreId: string | undefined = undefined;
        if (isSuperAdmin(req)) {
            targetStoreId = currentStoreId || requester.currentStoreId; // allow superadmin to set explicitly or fallback
        } else {
            if (!requester.currentStoreId) {
                return res.status(400).json({ message: 'No store selected. Set current store to create users.' });
            }
            targetStoreId = requester.currentStoreId;
        }

        // Premium seat gate: adding an extra user beyond the free allotment
        // requires the Team Members add-on. Superadmin bypasses (platform-level).
        if (!isSuperAdmin(req) && targetStoreId) {
            const seatRes = await db.query('SELECT COUNT(*)::int AS c FROM users WHERE current_store_id = $1', [targetStoreId]);
            const usedSeats = seatRes.rows[0]?.c ?? 0;
            const entitled = await isModuleEnabled(targetStoreId, MODULES.TEAM_MEMBERS);
            if (!entitled && usedSeats >= FREE_SEATS) {
                return res.status(402).json({
                    message: `Your plan includes ${FREE_SEATS} user seat. Unlock Team Members to add more staff.`,
                    code: 'MODULE_LOCKED',
                    module: MODULES.TEAM_MEMBERS,
                });
            }
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(String(password), salt);
        const id = generateId('user');
        // For staff, verification is not needed, so set is_verified to true and no token
        const verificationToken = null;
        const isVerified = true;

        const result = await db.query(
            'INSERT INTO users (id, name, email, password_hash, role, current_store_id, verification_token, is_verified) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [id, String(name), String(email).toLowerCase(), password_hash, String(role), targetStoreId ?? null, verificationToken, isVerified]
        );
        const newUser = result.rows[0];

        auditService.log(requester, 'User Created', `User: "${name}" (${email})`);
        res.status(201).json(toCamelCase(newUser));
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ message: 'Error creating user' });
    }
};

export const updateUser = async (req: express.Request, res: express.Response) => {
    const requester = req.user!;
    const { id } = req.params;
    const { name, email, role } = req.body || {};

    // Promoting a team member (e.g. staff → inventory manager) goes through
    // here, so the same whitelist applies: a store admin cannot escalate anyone
    // — themselves included — to superadmin.
    if (role !== undefined) {
        const roleError = roleAssignmentError(req, role);
        if (roleError) {
            return res.status(403).json({ message: roleError });
        }
    }

    try {
        // Enforce store isolation: ensure target belongs to same store for non-superadmin
        if (!isSuperAdmin(req)) {
            if (!requester.currentStoreId) {
                return res.status(400).json({ message: 'No store selected. Set current store to update users.' });
            }
            const check = await db.query('SELECT id FROM users WHERE id = $1 AND current_store_id = $2', [id, requester.currentStoreId]);
            if ((check.rowCount ?? 0) === 0) {
                return res.status(404).json({ message: 'User not found' });
            }
        }

        if (email) {
            const emailCheck = await db.query('SELECT id FROM users WHERE email = $1 AND id != $2', [String(email).toLowerCase(), id]);
            if ((emailCheck.rowCount ?? 0) > 0) {
                return res.status(400).json({ message: 'Email is already in use by another account' });
            }
        }

        // COALESCE so a partial update (say, role only) keeps the other fields.
        // Passing them straight through sent NULL for anything omitted, and
        // these columns are NOT NULL — the update failed with a 500 instead of
        // just changing the field the caller sent.
        const result = await db.query(
            `UPDATE users
                SET name = COALESCE($1, name),
                    email = COALESCE($2, email),
                    role = COALESCE($3, role)
              WHERE id = $4
              RETURNING id, name, email, role, is_verified`,
            [name ?? null, email ? String(email).toLowerCase() : null, role ?? null, id]
        );

        if ((result.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const updatedUser = result.rows[0];
        auditService.log(requester, 'User Updated', `User: "${updatedUser.name}" (${updatedUser.email})`);
        res.status(200).json(toCamelCase(updatedUser));
    } catch (error) {
        console.error(`Error updating user ${id}:`, error);
        res.status(500).json({ message: 'Error updating user' });
    }
};

export const deleteUser = async (req: express.Request, res: express.Response) => {
    const requester = req.user!;
    const { id } = req.params;

    if (id === requester?.id) {
        return res.status(400).json({ message: 'Cannot delete your own account.' });
    }

    try {
        // Enforce isolation: fetch target with store constraint for non-superadmin
        let userResult;
        if (isSuperAdmin(req)) {
            userResult = await db.query('SELECT role, name, email, current_store_id FROM users WHERE id = $1', [id]);
        } else {
            if (!requester.currentStoreId) {
                return res.status(400).json({ message: 'No store selected. Set current store to delete users.' });
            }
            userResult = await db.query('SELECT role, name, email, current_store_id FROM users WHERE id = $1 AND current_store_id = $2', [id, requester.currentStoreId]);
        }

        if ((userResult.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'User not found' });
        }
        const userToDelete = userResult.rows[0];

        if (userToDelete.role === 'admin') {
            // Only prevent deletion if this is the last admin in the same store context
            let adminCountQuery = "SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin'";
            const params: any[] = [];
            if (!isSuperAdmin(req)) {
                adminCountQuery += ' AND current_store_id = $1';
                params.push(requester.currentStoreId);
            } else if (userToDelete.current_store_id) {
                // If superadmin deleting, check within that target user's store to avoid orphaning a store with no admin
                adminCountQuery += ' AND current_store_id = $1';
                params.push(userToDelete.current_store_id);
            }
            const adminCountResult = await db.query(adminCountQuery, params);
            if ((adminCountResult.rows?.[0]?.count ?? 0) <= 1) {
                return res.status(400).json({ message: 'Cannot delete the only admin account in this store.' });
            }
        }

        await db.query('DELETE FROM users WHERE id = $1', [id]);
        auditService.log(requester, 'User Deleted', `User: "${userToDelete.name}" (${userToDelete.email})`);
        res.status(200).json({ message: 'User deleted' });

    } catch (error) {
        console.error(`Error deleting user ${id}:`, error);
        res.status(500).json({ message: 'Error deleting user' });
    }
};

export const setCurrentStore = async (req: express.Request, res: express.Response) => {
    try {
        const { storeId } = req.body || {};
        if (!storeId || typeof storeId !== 'string') {
            return res.status(400).json({ message: 'storeId is required' });
        }
        // Ensure the store exists
        const storeRes = await db.query('SELECT id, owner_id FROM stores WHERE id = $1', [storeId]);
        if ((storeRes.rowCount ?? 0) === 0) {
            return res.status(404).json({ message: 'Store not found' });
        }
        // Only the store's owner may switch into it — except the platform
        // superadmin (the Super Admin store picker uses this endpoint).
        if (req.user!.role !== 'superadmin' && storeRes.rows[0].owner_id !== req.user!.id) {
            return res.status(403).json({ message: 'You do not have access to that store.' });
        }
        // Update current user's store selection
        await db.query('UPDATE users SET current_store_id = $1 WHERE id = $2', [storeId, req.user!.id]);

        // Invalidate cache so next request sees new store immediately
        invalidateUserCache(req.user!.id);

        await auditService.log(req.user!, 'Set Current Store', `Selected store: ${storeId}`);
        return res.status(200).json({ currentStoreId: storeId });
    } catch (error) {
        console.error('Error setting current store:', error);
        return res.status(500).json({ message: 'Error setting current store' });
    }
};
