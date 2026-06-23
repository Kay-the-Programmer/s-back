import { Request, Response, NextFunction } from 'express';
import db from '../db_client';
import { SUBSCRIPTION_PLANS, getEffectivePlan } from '../services/subscription.service';

export const checkAiLimit = async (req: Request, res: Response, next: NextFunction) => {
    try {
        const user = req.user;
        if (!user || !user.currentStoreId) {
            return res.status(401).json({ message: 'Unauthorized. Store context missing.' });
        }

        const storeId = user.currentStoreId;
        const currentMonth = new Date().toISOString().slice(0, 7); // 'YYYY-MM'

        // 1. Get store subscription plan
        const storeRes = await db.query(
            'SELECT subscription_plan, subscription_status FROM stores WHERE id = $1',
            [storeId]
        );

        if (storeRes.rowCount === 0) {
            return res.status(404).json({ message: 'Store not found.' });
        }

        const { subscription_plan, subscription_status } = storeRes.rows[0];

        // If subscription is not active or trial, block AI usage (strict limitation)
        if (subscription_status !== 'active' && subscription_status !== 'trial') {
            return res.status(403).json({
                message: 'Your subscription is not active. Please upgrade to use AI features.',
                action: 'upgrade'
            });
        }

        // Read the Super-Admin-configured limit from the catalog (falls back to constants).
        const plan = (subscription_plan ? await getEffectivePlan(subscription_plan) : undefined) || SUBSCRIPTION_PLANS[0];

        if (plan.aiRequestsLimit === -1) {
            return next(); // Unlimited
        }

        // 2. Count requests this month
        const usageRes = await db.query(
            'SELECT COUNT(*) as count FROM ai_usage_logs WHERE store_id = $1 AND month_year = $2',
            [storeId, currentMonth]
        );

        const currentUsage = parseInt(usageRes.rows[0].count);

        if (currentUsage >= plan.aiRequestsLimit) {
            return res.status(429).json({
                message: `You have reached your monthly AI request limit (${plan.aiRequestsLimit}). Please upgrade your plan for more.`,
                limit: plan.aiRequestsLimit,
                usage: currentUsage,
                action: 'upgrade'
            });
        }

        next();
    } catch (error) {
        console.error('Error checking AI limit:', error);
        res.status(500).json({ message: 'Internal server error while verifying AI limits.' });
    }
};

export const logAiUsage = async (storeId: string, userId: string, feature: string, payload: any, responseSummary?: string) => {
    try {
        const currentMonth = new Date().toISOString().slice(0, 7);
        await db.query(
            `INSERT INTO ai_usage_logs (store_id, user_id, feature, request_payload, response_summary, month_year)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [storeId, userId, feature, JSON.stringify(payload), responseSummary, currentMonth]
        );
    } catch (error) {
        console.error('Error logging AI usage:', error);
        // Don't throw, just log. We don't want to break the user experience if logging fails.
    }
};
