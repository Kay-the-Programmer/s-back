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

router.get('/state', getOnboardingState);
router.patch('/complete-action', completeAction);
router.patch('/dismiss-helper', dismissHelper);
router.post('/reset', resetOnboarding);

export default router;
