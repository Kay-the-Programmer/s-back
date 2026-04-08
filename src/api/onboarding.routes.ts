import express from 'express';
import {
    getOnboardingState,
    completeAction,
    dismissHelper,
    resetOnboarding
} from '../controllers/onboarding.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// All routes require authentication
router.use(protect);

/**
 * @openapi
 * /onboarding/state:
 *   get:
 *     tags: [Onboarding]
 *     summary: Get the current onboarding state for the user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Onboarding state object
 */
router.get('/state', getOnboardingState);

/**
 * @openapi
 * /onboarding/complete-action:
 *   patch:
 *     tags: [Onboarding]
 *     summary: Mark an onboarding action as complete
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               actionId: { type: string }
 */
router.patch('/complete-action', completeAction);

/**
 * @openapi
 * /onboarding/dismiss-helper:
 *   patch:
 *     tags: [Onboarding]
 *     summary: Dismiss the onboarding helper widget
 *     security:
 *       - bearerAuth: []
 */
router.patch('/dismiss-helper', dismissHelper);

/**
 * @openapi
 * /onboarding/reset:
 *   post:
 *     tags: [Onboarding]
 *     summary: Reset onboarding progress
 *     security:
 *       - bearerAuth: []
 */
router.post('/reset', resetOnboarding);

export default router;
