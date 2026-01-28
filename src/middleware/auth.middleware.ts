import jwt from 'jsonwebtoken';
import db from '../db_client';
import express from 'express';
import { User } from '../types';

const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_DEV_ONLY';

// Simple in-memory cache for user records to reduce per-request DB lookups
// Keyed by user id, with a short TTL to balance freshness and performance
const USER_CACHE_TTL_MS = parseInt(process.env.AUTH_USER_CACHE_TTL_MS || '60000', 10); // default 60s
const userCache = new Map<string, { user: any; expires: number }>();

export const invalidateUserCache = (userId: string) => {
    userCache.delete(userId);
};

export const protect = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jwt.verify(token, JWT_SECRET) as { id: string };

            // Try cache first unless this is an explicit freshness-critical endpoint (e.g., /api/auth/me)
            let dbUser: any | undefined;
            const now = Date.now();
            const isFreshUserRequest = (req.originalUrl || req.url || '').includes('/api/auth/me');
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

            // Enforce store activation unless superadmin
            try {
                if (user.currentStoreId && user.role !== 'superadmin' && user.role !== 'customer') {
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
        } catch (error) {
            console.error(error);
            res.status(401).json({ message: 'Not authorized, token failed' });
        }
    }

    if (!token) {
        res.status(401).json({ message: 'Not authorized, no token' });
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

export const adminOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'superadmin')) {
        next();
    } else {
        res.status(403).json({ message: 'Forbidden: Admin access required' });
    }
};

export const superAdminOnly = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.user && req.user.role === 'superadmin') {
        next();
    } else {
        res.status(403).json({ message: 'Forbidden: Superadmin access required' });
    }
};

export const canManageInventory = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'inventory_manager')) {
        next();
    } else {
        res.status(403).json({ message: 'Forbidden: Inventory management access required' });
    }
};

export const canPerformSales = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.user && (req.user.role === 'admin' || req.user.role === 'staff')) {
        if (!req.user.isVerified && req.user.role !== 'admin') { // Admins can bypass? Maybe not. Let's block implies 'features to sale' so probably staff.
            // Requirement: "if they dont verify the email after sometime they wont be allowed to use the features to sale products"
            return res.status(403).json({ message: 'Forbidden: Email verification required to perform sales.', code: 'EMAIL_NOT_VERIFIED' });
        }
        next();
    } else {
        res.status(403).json({ message: 'Forbidden: Sales access required' });
    }
};