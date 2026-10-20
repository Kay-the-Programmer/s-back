import { Request, Response } from 'express';
import * as subscriptionService from '../services/subscription.service';
import { getPageModuleMap } from '../services/catalog.service';

export const getPlans = async (req: Request, res: Response) => {
    try {
        const plans = await subscriptionService.getPlans();
        res.json(plans);
    } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).json({ error: 'Failed to fetch subscription plans' });
    }
};

/** Page-key -> module-id map (from the catalog) so the client can gate pages by add-on. */
export const getPageModules = async (_req: Request, res: Response) => {
    try {
        res.json(await getPageModuleMap());
    } catch (error) {
        console.error('Error fetching page modules:', error);
        res.status(500).json({ error: 'Failed to fetch page modules' });
    }
};

/**
 * The store being billed is ALWAYS the caller's own active store, taken from
 * the server-side session. It is never read from the request: `billing:manage`
 * is held by every store owner, so a body-supplied storeId let any owner start
 * a payment against — and read the plan state of — somebody else's store.
 */
const billingStoreId = (req: Request): string | undefined =>
    (req as any).tenant?.storeId || req.user?.currentStoreId;

export const createPayment = async (req: Request, res: Response) => {
    try {
        const { planId, method, phoneNumber, billingCycle } = req.body;
        const storeId = billingStoreId(req);

        if (!storeId) {
            return res.status(400).json({ error: 'No store selected' });
        }
        if (!planId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const result = await subscriptionService.initiatePayment(storeId, planId, method, phoneNumber, billingCycle);
        res.json(result);
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({ error: 'Failed to initiate payment' });
    }
};

export const verifyPayment = async (req: Request, res: Response) => {
    try {
        const { reference } = req.params;
        const storeId = billingStoreId(req);

        if (!reference) {
            return res.status(400).json({ error: 'Reference is required' });
        }
        if (!storeId) {
            return res.status(400).json({ error: 'No store selected' });
        }

        const result = await subscriptionService.verifyPayment(reference, storeId);
        res.json(result);
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
};

export const cancelPayment = async (req: Request, res: Response) => {
    try {
        const { reference } = req.params;
        const storeId = billingStoreId(req);

        if (!reference) {
            return res.status(400).json({ error: 'Reference is required' });
        }
        if (!storeId) {
            return res.status(400).json({ error: 'No store selected' });
        }

        const result = await subscriptionService.cancelPayment(reference, storeId);
        res.json({ success: true, data: result });
    } catch (error: any) {
        console.error('Error cancelling payment:', error);
        res.status(400).json({ message: error.message || 'Failed to cancel payment' });
    }
};

/** Whether the current store's subscription plan auto-renews. */
export const getPlanAutoRenew = async (req: Request, res: Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ error: 'No shop is selected. Pick one from My Shops and try again.' });
        const autoRenew = await subscriptionService.getPlanAutoRenew(storeId);
        res.json({ autoRenew });
    } catch (error) {
        console.error('Error reading plan auto-renew:', error);
        res.status(500).json({ error: 'Failed to read auto-renew' });
    }
};

/** Toggle auto-renew for the current store's subscription plan. */
export const updatePlanAutoRenew = async (req: Request, res: Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const { autoRenew } = req.body || {};
        if (!storeId) return res.status(400).json({ error: 'No shop is selected. Pick one from My Shops and try again.' });
        if (typeof autoRenew !== 'boolean') return res.status(400).json({ error: 'autoRenew must be a boolean' });
        await subscriptionService.setPlanAutoRenew(storeId, autoRenew);
        res.json({ ok: true, autoRenew });
    } catch (error) {
        console.error('Error updating plan auto-renew:', error);
        res.status(500).json({ error: 'Failed to update auto-renew' });
    }
};

export const getHistory = async (req: Request, res: Response) => {
    try {
        // The :storeId in the path is honoured only for the platform operator.
        // For everyone else the caller's own store wins, so passing another
        // store's id can no longer read its payment history.
        const own = billingStoreId(req);
        const requested = req.params.storeId;
        const storeId = req.user?.role === 'superadmin' ? (requested || own) : own;
        if (!storeId) {
            return res.status(400).json({ error: 'Store ID is required' });
        }
        if (req.user?.role !== 'superadmin' && requested && requested !== storeId) {
            return res.status(403).json({ error: 'Forbidden: not your store' });
        }

        const history = await subscriptionService.getSubscriptionHistory(storeId);
        res.json(history);
    } catch (error) {
        console.error('Error fetching subscription history:', error);
        res.status(500).json({ error: 'Failed to fetch subscription history' });
    }
};

// ── Refunds ─────────────────────────────────────────────────────────────────
// The store-facing money-back window is not live: refund.service.ts was never
// written, so getRefundEligibility/requestRefund are removed rather than left
// calling a service that does not exist. Restore both here alongside the
// service, the refund_requests table and a real support-contact helper.
