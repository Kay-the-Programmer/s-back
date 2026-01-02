import express from 'express';
import { listStores, updateStore, createNotification, listRevenueSummary, listSubscriptionPayments, recordSubscriptionPayment } from '../controllers/superadmin.controller';
import { protect, superAdminOnly } from '../middleware/auth.middleware';

const router = express.Router();

// Store management
router.get('/stores', protect, superAdminOnly, listStores);
router.patch('/stores/:id', protect, superAdminOnly, updateStore);

// System-wide notifications
router.post('/notifications', protect, superAdminOnly, createNotification);

// Subscription revenue management
router.get('/revenue/summary', protect, superAdminOnly, listRevenueSummary);
router.get('/revenue/payments', protect, superAdminOnly, listSubscriptionPayments);
router.post('/revenue/payments', protect, superAdminOnly, recordSubscriptionPayment);

export default router;
