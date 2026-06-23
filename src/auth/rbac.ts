/**
 * Centralized Role-Based Access Control (RBAC)
 * --------------------------------------------------------------------------
 * Single source of truth for *what each role is allowed to do*.
 *
 * - `Role`          – the identity a user carries (stored on users.role).
 * - `Permission`    – a fine-grained `resource:action` capability.
 * - `ROLE_PERMISSIONS` – the matrix mapping each role to its capabilities.
 *
 * Route handlers should depend on Permissions (via `requirePermission`)
 * rather than hard-coding role names, so that the access model can evolve in
 * one place. `authorize(...roles)` remains available for the rare cases where
 * gating on identity (rather than capability) is genuinely what we want
 * (e.g. platform-only endpoints).
 *
 * The model is DENY BY DEFAULT: a role only has a permission if it is listed
 * explicitly in the matrix below.
 */
import express from 'express';

export type Role =
    | 'superadmin'
    | 'admin'
    | 'staff'
    | 'inventory_manager'
    | 'customer'
    | 'supplier';

export type Permission =
    // Platform administration (SaaS owner)
    | 'platform:manage'
    // Team & access control
    | 'users:manage'
    // Store settings
    | 'settings:read'
    | 'settings:manage'
    // Finance
    | 'accounting:manage'
    | 'expenses:manage'
    | 'billing:manage'
    // Audit trail
    | 'audit:read'
    // Inventory / products / categories
    | 'inventory:read'
    | 'inventory:manage'
    // Suppliers & purchasing (purchase orders, stock takes)
    | 'suppliers:manage'
    | 'purchasing:manage'
    // Sales / POS
    | 'sales:read'
    | 'sales:perform'
    // Returns
    | 'returns:perform'
    // Customers (CRM)
    | 'customers:read'
    | 'customers:create'
    | 'customers:manage'
    // Reports
    | 'reports:dashboard'
    | 'reports:sales'
    // Logistics
    | 'logistics:read'
    | 'logistics:manage'
    // Messaging integrations (WhatsApp / SMS)
    | 'messaging:read'
    | 'messaging:send'
    | 'messaging:manage'
    // AI assistant tools
    | 'ai:use';

/**
 * Every store-level permission (i.e. everything except platform administration).
 * A store `admin` holds all of these for their own store; `superadmin` holds
 * these plus `platform:manage`.
 */
const STORE_PERMISSIONS: Permission[] = [
    'users:manage',
    'settings:read',
    'settings:manage',
    'accounting:manage',
    'expenses:manage',
    'billing:manage',
    'audit:read',
    'inventory:read',
    'inventory:manage',
    'suppliers:manage',
    'purchasing:manage',
    'sales:read',
    'sales:perform',
    'returns:perform',
    'customers:read',
    'customers:create',
    'customers:manage',
    'reports:dashboard',
    'reports:sales',
    'logistics:read',
    'logistics:manage',
    'messaging:read',
    'messaging:send',
    'messaging:manage',
    'ai:use',
];

/**
 * The access-control matrix. DENY BY DEFAULT — a role can only do what is
 * listed here.
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
    // Platform owner: full access to every store-level capability plus the
    // platform administration surface.
    superadmin: ['platform:manage', ...STORE_PERMISSIONS],

    // Store owner / administrator: full control of a single store.
    admin: [...STORE_PERMISSIONS],

    // Inventory manager: stock, products, suppliers, purchasing and the
    // operational dashboard. No sales, finance, team or settings management.
    inventory_manager: [
        'inventory:read',
        'inventory:manage',
        'suppliers:manage',
        'purchasing:manage',
        'reports:dashboard',
        'settings:read',
        'logistics:read',
        'logistics:manage',
        'ai:use',
    ],

    // Sales staff: the POS, sales, returns, basic CRM and inventory look-ups.
    // Cannot edit/delete customers, manage stock, finance or team.
    staff: [
        'inventory:read',
        'sales:read',
        'sales:perform',
        'returns:perform',
        'customers:read',
        'customers:create',
        'reports:sales',
        'settings:read',
        'logistics:read',
        'logistics:manage',
        'messaging:read',
        'messaging:send',
        'ai:use',
    ],

    // External customers and suppliers have no store-management permissions.
    // They interact through dedicated shop / marketplace endpoints.
    customer: [],
    supplier: [],
};

/** Does the given role hold the given permission? */
export const roleHasPermission = (role: Role | undefined, permission: Permission): boolean => {
    if (!role) return false;
    const perms = ROLE_PERMISSIONS[role];
    return !!perms && perms.includes(permission);
};

/** All permissions held by a role (useful for surfacing to the client). */
export const permissionsForRole = (role: Role | undefined): Permission[] =>
    role && ROLE_PERMISSIONS[role] ? [...ROLE_PERMISSIONS[role]] : [];

const forbidden = (res: express.Response, message: string) =>
    res.status(403).json({ message, code: 'FORBIDDEN' });

const unauthenticated = (res: express.Response) =>
    res.status(401).json({ message: 'Not authorized, no token', code: 'NO_TOKEN' });

/**
 * Gate a route on one or more permissions. The user must hold EVERY permission
 * listed. Must run after `protect` (which populates req.user).
 */
export const requirePermission = (...permissions: Permission[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const role = req.user?.role as Role | undefined;
        if (!req.user) return unauthenticated(res);
        const ok = permissions.every(p => roleHasPermission(role, p));
        if (!ok) {
            return forbidden(res, `Forbidden: requires permission ${permissions.join(', ')}`);
        }
        next();
    };

/**
 * Gate a route on one or more permissions where holding ANY one is sufficient.
 */
export const requireAnyPermission = (...permissions: Permission[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
        const role = req.user?.role as Role | undefined;
        if (!req.user) return unauthenticated(res);
        const ok = permissions.some(p => roleHasPermission(role, p));
        if (!ok) {
            return forbidden(res, `Forbidden: requires one of ${permissions.join(', ')}`);
        }
        next();
    };

/**
 * Gate a route on identity (role membership). Prefer `requirePermission` for
 * capability checks; use this only for genuinely role-scoped surfaces.
 */
export const authorize = (...roles: Role[]) =>
    (req: express.Request, res: express.Response, next: express.NextFunction) => {
        if (!req.user) return unauthenticated(res);
        if (!roles.includes(req.user.role as Role)) {
            return forbidden(res, `Forbidden: requires role ${roles.join(', ')}`);
        }
        next();
    };
