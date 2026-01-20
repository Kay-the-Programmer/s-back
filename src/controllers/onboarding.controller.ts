import express from 'express';
import db from '../db_client';

interface OnboardingState {
    completedActions: string[];
    dismissedHelpers: string[];
    lastUpdated: string | null;
}

/**
 * Get the current user's onboarding state
 */
export async function getOnboardingState(req: express.Request, res: express.Response) {
    try {
        const userId = (req as any).user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const result = await db.query(
            'SELECT onboarding_state FROM users WHERE id = $1',
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const state: OnboardingState = result.rows[0].onboarding_state || {
            completedActions: [],
            dismissedHelpers: [],
            lastUpdated: null
        };

        res.json(state);
    } catch (error: any) {
        console.error('Error fetching onboarding state:', error);
        res.status(500).json({ message: 'Failed to fetch onboarding state', error: error.message });
    }
}

/**
 * Mark an action as completed
 */
export async function completeAction(req: express.Request, res: express.Response) {
    try {
        const userId = (req as any).user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { actionId } = req.body;
        if (!actionId || typeof actionId !== 'string') {
            return res.status(400).json({ message: 'actionId is required and must be a string' });
        }

        // Get current state
        const result = await db.query(
            'SELECT onboarding_state FROM users WHERE id = $1',
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const currentState: OnboardingState = result.rows[0].onboarding_state || {
            completedActions: [],
            dismissedHelpers: [],
            lastUpdated: null
        };

        // Add action if not already completed
        if (!currentState.completedActions.includes(actionId)) {
            currentState.completedActions.push(actionId);
        }
        currentState.lastUpdated = new Date().toISOString();

        // Update database
        await db.query(
            'UPDATE users SET onboarding_state = $1 WHERE id = $2',
            [JSON.stringify(currentState), userId]
        );

        res.json(currentState);
    } catch (error: any) {
        console.error('Error completing action:', error);
        res.status(500).json({ message: 'Failed to complete action', error: error.message });
    }
}

/**
 * Mark a helper as dismissed
 */
export async function dismissHelper(req: express.Request, res: express.Response) {
    try {
        const userId = (req as any).user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const { helperId } = req.body;
        if (!helperId || typeof helperId !== 'string') {
            return res.status(400).json({ message: 'helperId is required and must be a string' });
        }

        // Get current state
        const result = await db.query(
            'SELECT onboarding_state FROM users WHERE id = $1',
            [userId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found' });
        }

        const currentState: OnboardingState = result.rows[0].onboarding_state || {
            completedActions: [],
            dismissedHelpers: [],
            lastUpdated: null
        };

        // Add helper if not already dismissed
        if (!currentState.dismissedHelpers.includes(helperId)) {
            currentState.dismissedHelpers.push(helperId);
        }
        currentState.lastUpdated = new Date().toISOString();

        // Update database
        await db.query(
            'UPDATE users SET onboarding_state = $1 WHERE id = $2',
            [JSON.stringify(currentState), userId]
        );

        res.json(currentState);
    } catch (error: any) {
        console.error('Error dismissing helper:', error);
        res.status(500).json({ message: 'Failed to dismiss helper', error: error.message });
    }
}

/**
 * Reset onboarding state (for testing or allowing users to restart)
 */
export async function resetOnboarding(req: express.Request, res: express.Response) {
    try {
        const userId = (req as any).user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const freshState: OnboardingState = {
            completedActions: [],
            dismissedHelpers: [],
            lastUpdated: new Date().toISOString()
        };

        await db.query(
            'UPDATE users SET onboarding_state = $1 WHERE id = $2',
            [JSON.stringify(freshState), userId]
        );

        res.json(freshState);
    } catch (error: any) {
        console.error('Error resetting onboarding:', error);
        res.status(500).json({ message: 'Failed to reset onboarding', error: error.message });
    }
}
