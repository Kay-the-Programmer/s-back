import { Router } from 'express';
import * as subscriptionController from '../controllers/subscription.controller'; // Adjust path if needed
import { protect } from '../middleware/auth.middleware'; // Adjust import if auth middleware exists

const router = Router();

// Public or Protected? Plans can be public, but payments need auth/store context
router.get('/plans', subscriptionController.getPlans);
router.post('/pay', subscriptionController.createPayment);

export default router;
