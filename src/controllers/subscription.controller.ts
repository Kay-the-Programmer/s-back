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

        // For the mock flow, we will immediately "process" it successfully to simulate a completed payment
        // In a real app, this would happen via webhook or a separate confirmation step
        try {
            await subscriptionService.processMockPayment(result.paymentId);
            result.status = 'completed';
            result.message = 'Payment successful (Mock)';
        } catch (processError) {
            console.error('Mock processing failed:', processError);
            // Keep it pending if mock processing fails
        }

        res.json(result);
    } catch (error) {
        console.error('Error creating payment:', error);
        res.status(500).json({ error: 'Failed to initiate payment' });
    }
};
