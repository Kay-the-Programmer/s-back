import { Request, Response } from 'express';
import * as subscriptionService from '../services/subscription.service';
import * as modulePurchaseService from '../services/module-purchase.service';
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

export const createPayment = async (req: Request, res: Response) => {
    try {
        const { storeId, planId, method, phoneNumber, billingCycle } = req.body;

        if (!storeId || !planId) {
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

        if (!reference) {
            return res.status(400).json({ error: 'Reference is required' });
        }

        const result = await subscriptionService.verifyPayment(reference);
        res.json(result);
    } catch (error) {
        console.error('Error verifying payment:', error);
        res.status(500).json({ error: 'Failed to verify payment' });
    }
};

export const cancelPayment = async (req: Request, res: Response) => {
    try {
        const { reference } = req.params;

        if (!reference) {
            return res.status(400).json({ error: 'Reference is required' });
        }

        const result = await subscriptionService.cancelPayment(reference);
        res.json({ success: true, data: result });
    } catch (error: any) {
        console.error('Error cancelling payment:', error);
        res.status(400).json({ message: error.message || 'Failed to cancel payment' });
    }
};

/** List add-on modules the current store can buy à la carte. */
export const listAddons = async (req: Request, res: Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ error: 'Store context missing' });
        const addons = await modulePurchaseService.getPurchasableAddons(storeId);
        res.json(addons);
    } catch (error) {
        console.error('Error listing add-ons:', error);
        res.status(500).json({ error: 'Failed to load add-ons' });
    }
};

/** Initiate payment for one or more à-la-carte add-ons. */
export const buyAddons = async (req: Request, res: Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const { moduleIds, method, phoneNumber } = req.body || {};
        if (!storeId) return res.status(400).json({ error: 'Store context missing' });
        if (!Array.isArray(moduleIds) || moduleIds.length === 0) {
            return res.status(400).json({ error: 'No add-ons selected' });
        }
        const result = await modulePurchaseService.initiateModulePayment(storeId, moduleIds, method, phoneNumber);
        res.json(result);
    } catch (error: any) {
        console.error('Error initiating add-on payment:', error);
        res.status(400).json({ message: error.message || 'Failed to initiate add-on payment' });
    }
};

/** Whether the current store's subscription plan auto-renews. */
export const getPlanAutoRenew = async (req: Request, res: Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ error: 'Store context missing' });
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
        if (!storeId) return res.status(400).json({ error: 'Store context missing' });
        if (typeof autoRenew !== 'boolean') return res.status(400).json({ error: 'autoRenew must be a boolean' });
        await subscriptionService.setPlanAutoRenew(storeId, autoRenew);
        res.json({ ok: true, autoRenew });
    } catch (error) {
        console.error('Error updating plan auto-renew:', error);
        res.status(500).json({ error: 'Failed to update auto-renew' });
    }
};

/** Toggle auto-renew for one of the current store's à-la-carte add-ons. */
export const setAddonAutoRenew = async (req: Request, res: Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const { moduleId } = req.params;
        const { autoRenew } = req.body || {};
        if (!storeId) return res.status(400).json({ error: 'Store context missing' });
        if (typeof autoRenew !== 'boolean') return res.status(400).json({ error: 'autoRenew must be a boolean' });
        await modulePurchaseService.setAddonAutoRenew(storeId, moduleId, autoRenew);
        res.json({ ok: true, moduleId, autoRenew });
    } catch (error) {
        console.error('Error updating add-on auto-renew:', error);
        res.status(500).json({ error: 'Failed to update auto-renew' });
    }
};

export const getHistory = async (req: Request, res: Response) => {
    try {
        const { storeId } = req.params;
        if (!storeId) {
            return res.status(400).json({ error: 'Store ID is required' });
        }

        const history = await subscriptionService.getSubscriptionHistory(storeId);
        res.json(history);
    } catch (error) {
        console.error('Error fetching subscription history:', error);
        res.status(500).json({ error: 'Failed to fetch subscription history' });
    }
};
