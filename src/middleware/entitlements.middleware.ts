import express from 'express';
import { isModuleEnabled } from '../services/entitlements.service';

/**
 * Server-side entitlement gate for premium add-on modules.
 *
 * Frontend hiding is UX, not security — without this a user can call a gated
 * API directly. Apply this to wholly-premium route groups, or use
 * `ensureModule` inline for a premium sub-feature inside an otherwise-core
 * controller.
 *
 * Responds with **402 Payment Required** (distinct from 403 role-forbidden) so
 * the client can show an "upgrade" prompt rather than a permissions error.
 */
export const requireModule = (moduleId: string) =>
    async (req: express.Request, res: express.Response, next: express.NextFunction) => {
        // Platform admins bypass entitlement checks.
        if (req.user?.role === 'superadmin') return next();

        const storeId = req.user?.currentStoreId;
        if (await isModuleEnabled(storeId, moduleId)) return next();

        return res.status(402).json({
            message: 'This feature is not included in your plan. Upgrade to unlock it.',
            module: moduleId,
            action: 'upgrade',
        });
    };

/**
 * Inline guard for controllers that gate a single premium sub-feature. Returns
 * `true` when entitled; otherwise writes a 402 and returns `false` so the caller
 * can `if (!(await ensureModule(...))) return;`.
 */
export const ensureModule = async (
    req: express.Request,
    res: express.Response,
    moduleId: string,
): Promise<boolean> => {
    if (req.user?.role === 'superadmin') return true;
    if (await isModuleEnabled(req.user?.currentStoreId, moduleId)) return true;
    res.status(402).json({
        message: 'This feature is not included in your plan. Upgrade to unlock it.',
        module: moduleId,
        action: 'upgrade',
    });
    return false;
};
