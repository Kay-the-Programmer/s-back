import express from 'express';
import authRoutes from './auth.routes';
import productRoutes from './products.routes';
import salesRoutes from './sales.routes';
import aiRoutes from './ai.routes';
import customerRoutes from './customers.routes';
import supplierRoutes from './suppliers.routes';
import categoryRoutes from './categories.routes';
import userRoutes from './users.routes';
import returnRoutes from './returns.routes';
import purchaseOrderRoutes from './purchase-orders.routes';
import orderListRoutes from './order-lists.routes';
import stockTakeRoutes from './stock-takes.routes';
import accountingRoutes from './accounting.routes';
import settingsRoutes from './settings.routes';
import reportRoutes from './reports.routes';
import auditRoutes from './audit.routes';
import storeRoutes from './stores.routes';
import superadminRoutes from './superadmin.routes';
import shopRoutes from './shop.routes';
import marketplaceRoutes from './marketplace.routes';
import notificationRoutes from './notifications.routes';
import pushRoutes from './push.routes';
import expenseRoutes from './expenses.routes';
import onboardingRoutes from './onboarding.routes';
import subscriptionRoutes from './subscription.routes';
import offerRoutes from './offers.routes';
import messageRoutes from './messages.routes';
import verificationRoutes from './verification.routes';

import paymentRoutes from './payments.routes';
import recurringExpenseRoutes from './recurring-expenses.routes';
import logisticsRoutes from './logistics.routes';


import whatsappRoutes from './whatsapp.routes';
import facebookRoutes from './facebook.routes';
import smsRoutes from './sms.routes';

const router = express.Router();

// --- API Route Definitions ---
router.use('/auth', authRoutes);
router.use('/products', productRoutes);
router.use('/sales', salesRoutes);
router.use('/ai', aiRoutes);
router.use('/customers', customerRoutes);
router.use('/suppliers', supplierRoutes);
router.use('/categories', categoryRoutes);
router.use('/users', userRoutes);
router.use('/returns', returnRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/order-lists', orderListRoutes);
router.use('/stock-takes', stockTakeRoutes);
router.use('/accounting', accountingRoutes);
router.use('/settings', settingsRoutes);
router.use('/reports', reportRoutes);
router.use('/audit', auditRoutes);
router.use('/stores', storeRoutes);
router.use('/superadmin', superadminRoutes);
router.use('/shop', shopRoutes);
router.use('/marketplace', marketplaceRoutes);
router.use('/notifications', notificationRoutes);
router.use('/push', pushRoutes);
router.use('/expenses', expenseRoutes);
router.use('/onboarding', onboardingRoutes);
router.use('/subscriptions', subscriptionRoutes);
router.use('/offers', offerRoutes);
router.use('/messages', messageRoutes);
router.use('/verification', verificationRoutes);
router.use('/payments', paymentRoutes);
router.use('/recurring-expenses', recurringExpenseRoutes);
router.use('/logistics', logisticsRoutes);
router.use('/whatsapp', whatsappRoutes);
router.use('/facebook', facebookRoutes);
router.use('/sms', smsRoutes);


// A simple health check endpoint
router.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK', timestamp: new Date().toISOString() });
});


export default router;