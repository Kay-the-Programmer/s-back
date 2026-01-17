import express from 'express';
import { listStores, updateStore, createNotification, listSystemNotifications, getNotificationStatus, listRevenueSummary, listSubscriptionPayments, recordSubscriptionPayment, getStoreDetails, sendStoreNotification } from '../controllers/superadmin.controller';
import { protect, superAdminOnly } from '../middleware/auth.middleware';

const router = express.Router();

// Store management

// Store management
router.get('/stores', protect, superAdminOnly, listStores);
router.get('/stores/:id', protect, superAdminOnly, getStoreDetails);
router.patch('/stores/:id', protect, superAdminOnly, updateStore);
router.post('/stores/:id/notifications', protect, superAdminOnly, sendStoreNotification);

// System-wide notifications
router.post('/notifications', protect, superAdminOnly, createNotification);
router.get('/notifications', protect, superAdminOnly, listSystemNotifications);
router.get('/notifications/:id/status', protect, superAdminOnly, getNotificationStatus);

// Subscription revenue management
router.get('/revenue/summary', protect, superAdminOnly, listRevenueSummary);
router.get('/revenue/payments', protect, superAdminOnly, listSubscriptionPayments);
router.post('/revenue/payments', protect, superAdminOnly, recordSubscriptionPayment);

export default router;
