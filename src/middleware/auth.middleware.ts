import jwt from 'jsonwebtoken';
import db from '../db_client';
import express from 'express';
import { User } from '../types';
import { authorize, requirePermission, roleHasPermission, Role } from '../auth/rbac';

// Re-export the centralized RBAC helpers so routes can import everything
// authorization-related from a single module if they prefer.
export { authorize, requirePermission, requireAnyPermission, roleHasPermission, ROLE_PERMISSIONS, permissionsForRole } from '../auth/rbac';
export type { Role, Permission } from '../auth/rbac';

// In production a missing JWT_SECRET must be a hard failure: falling back to a
// publicly-known string would make every auth token forgeable.
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    throw new Error('FATAL: JWT_SECRET must be set in production.');
}
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_DEV_ONLY';

// Per-request auth logging is opt-in (AUTH_DEBUG=true): it floods production
// logs (2 lines × every request × every polling client) and leaks token prefixes.
const AUTH_DEBUG = process.env.AUTH_DEBUG === 'true';

// Simple in-memory cache for user records to reduce per-request DB lookups
// Keyed by user id, with a short TTL to balance freshness and performance
const USER_CACHE_TTL_MS = parseInt(process.env.AUTH_USER_CACHE_TTL_MS || '60000', 10); // default 60s
const userCache = new Map<string, { user: any; expires: number }>();

export const invalidateUserCache = (userId: string) => {
    userCache.delete(userId);
};

export const protect = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    let token;
    const authHeader = req.headers.authorization;
    const url = req.originalUrl || req.url;
    
    if (AUTH_DEBUG) console.log(`[auth] Request to ${url} | Auth header: ${authHeader ? 'present' : 'missing'}`);

    if (authHeader && authHeader.startsWith('Bearer')) {
        try {
            token = authHeader.split(' ')[1];
            if (AUTH_DEBUG) console.log(`[auth] Token found: ${token.substring(0, 10)}...`);
            const decoded = jwt.verify(token, JWT_SECRET) as { id: string };

            // Try cache first unless this is an explicit freshness-critical endpoint (e.g., /api/auth/me)
            let dbUser: any | undefined;
            const now = Date.now();
            const currentUrl = (req.originalUrl || req.url || '').toLowerCase();
            const isFreshUserRequest = currentUrl.endsWith('/auth/me') || currentUrl.includes('/auth/me?');
            const cacheEntry = userCache.get(decoded.id);
            if (!isFreshUserRequest && cacheEntry && cacheEntry.expires > now && cacheEntry.user && cacheEntry.user.current_store_id) {
                dbUser = cacheEntry.user;
            } else {
                const result = await db.query(`
                    SELECT u.id, u.name, u.email, u.role, u.phone, u.current_store_id, u.is_verified,
                           s.subscription_status, s.subscription_ends_at, s.subscription_plan
                    FROM users u
                    LEFT JOIN stores s ON u.current_store_id = s.id
                    WHERE u.id = $1
                `, [decoded.id]);
                dbUser = result.rows[0] as any;
                if (dbUser) {
                    // If TTL is 0 (disabled), do not cache
                    if (USER_CACHE_TTL_MS > 0) {
                        userCache.set(decoded.id, { user: dbUser, expires: now + USER_CACHE_TTL_MS });
                    } else {
                        userCache.delete(decoded.id);
                    }
                }
            }
            if (!dbUser) {
                return res.status(401).json({ message: 'Not authorized, user not found' });
            }
            if (dbUser.current_store_id) {
                // Attach tenant context for convenience
                (req as any).tenant = { storeId: dbUser.current_store_id };
            }
            // Normalize to camelCase for req.user
            const user: User = {
                id: dbUser.id,
                name: dbUser.name,
                email: dbUser.email,
                phone: dbUser.phone,
                role: dbUser.role,
                currentStoreId: dbUser.current_store_id || undefined,
                isVerified: dbUser.is_verified,
                subscriptionStatus: dbUser.subscription_status,
                subscriptionEndsAt: dbUser.subscription_ends_at,
                subscriptionPlan: dbUser.subscription_plan,
            };
            req.user = user;

            // Enforce store activation unless superadmin.
            // Store-agnostic routes are exempt: /auth/* (session) and /stores/*
            // (the Business Manager — check-name, register, mine, summary,
            // switch, verify are all account-level). Without this, an owner
            // whose ACTIVE store is suspended could never switch to one of
            // their healthy businesses — the whole account would be bricked.
            const storeAgnostic = /^\/api\/(auth|stores)(\/|$|\?)/.test((req.originalUrl || req.url || '').toLowerCase());
            try {
                if (!storeAgnostic && user.currentStoreId && user.role !== 'superadmin' && user.role !== 'customer') {
                    const storeRes = await db.query('SELECT status, subscription_status FROM stores WHERE id = $1', [user.currentStoreId]);
                    const store = storeRes.rows[0];
                    if (!store) {
                        return res.status(403).json({ message: 'Store not found or not accessible' });
                    }
                    if (store.status !== 'active') {
                        return res.status(403).json({ message: `Store is ${store.status}. Please contact support.` });
                    }
                    if (store.subscription_status === 'past_due') {
                        // Optionally allow grace; not blocking for past_due here.
                    }
                    if (store.subscription_status === 'canceled') {
                        return res.status(403).json({ message: 'Subscription canceled. Store is not accessible.' });
                    }
                }
            } catch (e) {
                console.error('Store enforcement error', e);
                // Fail closed for safety
                return res.status(403).json({ message: 'Access denied due to store status' });
            }

            next();
        } catch (error: any) {
            console.error('[auth] JWT verification failed:', error.message);
            return res.status(401).json({ 
                message: 'Not authorized, token failed', 
                details: error.message,
                code: 'TOKEN_INVALID'
            });
        }
    }

    if (!token) {
        return res.status(401).json({ 
            message: 'Not authorized, no token',
            code: 'NO_TOKEN'
        });
    }
};

export const optionalProtect = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            if (!token || token === 'null' || token === 'undefined') {
                return next();
            }
            const decoded = jwt.verify(token, JWT_SECRET) as { id: string };

            const result = await db.query(`
                SELECT u.id, u.name, u.email, u.role, u.phone, u.current_store_id, u.is_verified,
                       s.subscription_status, s.subscription_ends_at, s.subscription_plan
                FROM users u
                LEFT JOIN stores s ON u.current_store_id = s.id
                WHERE u.id = $1
            `, [decoded.id]);
            const dbUser = result.rows[0];

            if (dbUser) {
                req.user = {
                    id: dbUser.id,
                    name: dbUser.name,
                    email: dbUser.email,
                    phone: dbUser.phone,
                    role: dbUser.role as any,
                    currentStoreId: dbUser.current_store_id,
                    isVerified: dbUser.is_verified,
                    subscriptionStatus: dbUser.subscription_status,
                    subscriptionEndsAt: dbUser.subscription_ends_at,
                    subscriptionPlan: dbUser.subscription_plan
                } as any;
            }
        } catch (error) {
            console.error('Optional auth failed:', error);
            // Don't fail the request, just proceed without req.user
        }
    }
    next();
};

/**
 * Legacy role guards — retained for backwards compatibility but now implemented
 * in terms of the centralized RBAC matrix (see src/auth/rbac.ts). Prefer
 * `requirePermission(...)` in new code.
 */

// Admin-level store management (also satisfied by the platform superadmin).
export const adminOnly = authorize('admin', 'superadmin');

// Platform-only surface.
export const superAdminOnly = authorize('superadmin');

// Anyone who can manage inventory (admin, inventory_manager, superadmin).
export const canManageInventory = requirePermission('inventory:manage');

// Anyone who can operate the POS, with the additional email-verification gate.
// Requirement: an unverified non-admin must verify their email before selling.
export const canPerformSales = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!req.user) {
        return res.status(401).json({ message: 'Not authorized, no token', code: 'NO_TOKEN' });
    }
    if (!roleHasPermission(req.user.role as Role, 'sales:perform')) {
        return res.status(403).json({ message: 'Forbidden: Sales access required', code: 'FORBIDDEN' });
    }
    if (!req.user.isVerified && req.user.role !== 'admin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ message: 'Forbidden: Email verification required to perform sales.', code: 'EMAIL_NOT_VERIFIED' });
    }
    next();
};