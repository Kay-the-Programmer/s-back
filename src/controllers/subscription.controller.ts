import { Request, Response } from 'express';
import * as subscriptionService from '../services/subscription.service';

export const getPlans = async (req: Request, res: Response) => {
    try {
        const plans = await subscriptionService.getPlans();
        res.json(plans);
    } catch (error) {
        console.error('Error fetching plans:', error);
        res.status(500).json({ error: 'Failed to fetch subscription plans' });
    }
};

export const createPayment = async (req: Request, res: Response) => {
    try {
        const { storeId, planId, method, phoneNumber } = req.body;

        if (!storeId || !planId) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        const result = await subscriptionService.initiatePayment(storeId, planId, method, phoneNumber);
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
