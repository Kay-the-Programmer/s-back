import express from 'express';
import { listStores, updateStore, createNotification, listSystemNotifications, getNotificationStatus, listRevenueSummary, listSubscriptionPayments, recordSubscriptionPayment, getStoreDetails, sendStoreNotification, setStoreModules, getStoreModules, previewStoreDeletion, deleteStore } from '../controllers/superadmin.controller';
import { handleSuperAdminChat } from '../controllers/ai.controller';
import {
    listCatalogModules, saveCatalogModule, removeCatalogModule,
    listCatalogPlans, saveCatalogPlan, removeCatalogPlan,
} from '../controllers/catalog.controller';
import {
    listCampaigns, saveCampaign, removeCampaign,
} from '../controllers/upsell-campaign.controller';
import { getUpsellAnalytics } from '../controllers/upsell-analytics.controller';
import {
    listEmailTemplatesHandler, createEmailTemplateHandler, updateEmailTemplateHandler,
    deleteEmailTemplateHandler, resetEmailTemplateHandler,
    previewEmailTemplateHandler, testEmailTemplateHandler,
} from '../controllers/email-templates.controller';
import { protect, superAdminOnly } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /superadmin/stores:
 *   get:
 *     tags: [Super Admin]
 *     summary: List all stores in the system
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of all stores
 */
router.get('/stores', protect, superAdminOnly, listStores);

/**
 * @openapi
 * /superadmin/stores/{id}:
 *   get:
 *     tags: [Super Admin]
 *     summary: Get store details by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *   patch:
 *     tags: [Super Admin]
 *     summary: Update store details or status
 *     security:
 *       - bearerAuth: []
 */
router.get('/stores/:id', protect, superAdminOnly, getStoreDetails);
router.patch('/stores/:id', protect, superAdminOnly, updateStore);

/**
 * @openapi
 * /superadmin/stores/{id}/deletion-preview:
 *   get:
 *     tags: [Super Admin]
 *     summary: What deleting this store would destroy. Changes nothing.
 *     security:
 *       - bearerAuth: []
 */
router.get('/stores/:id/deletion-preview', protect, superAdminOnly, previewStoreDeletion);

/**
 * @openapi
 * /superadmin/stores/{id}:
 *   delete:
 *     tags: [Super Admin]
 *     summary: Erase a store and all its data. Irreversible; the store's name must be typed back.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: What was destroyed
 *       400:
 *         description: The typed name did not match
 */
router.delete('/stores/:id', protect, superAdminOnly, deleteStore);

/**
 * @openapi
 * /superadmin/stores/{id}/notifications:
 *   post:
 *     tags: [Super Admin]
 *     summary: Send a notification to a specific store
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/stores/:id/notifications', protect, superAdminOnly, sendStoreNotification);

/**
 * @openapi
 * /superadmin/stores/{id}/modules:
 *   get:
 *     tags: [Super Admin]
 *     summary: Get premium modules granted to a store
 *     security: [{ bearerAuth: [] }]
 *   put:
 *     tags: [Super Admin]
 *     summary: Grant/revoke premium modules for a store (unlock at a fee)
 *     security: [{ bearerAuth: [] }]
 */
router.get('/stores/:id/modules', protect, superAdminOnly, getStoreModules);
router.put('/stores/:id/modules', protect, superAdminOnly, setStoreModules);

/**
 * @openapi
 * /superadmin/notifications:
 *   post:
 *     tags: [Super Admin]
 *     summary: Create a system-wide notification
 *     security:
 *       - bearerAuth: []
 *   get:
 *     tags: [Super Admin]
 *     summary: Get all system notifications
 *     security:
 *       - bearerAuth: []
 */
router.post('/notifications', protect, superAdminOnly, createNotification);
router.get('/notifications', protect, superAdminOnly, listSystemNotifications);

/**
 * @openapi
 * /superadmin/notifications/{id}/status:
 *   get:
 *     tags: [Super Admin]
 *     summary: Get notification delivery status
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/notifications/:id/status', protect, superAdminOnly, getNotificationStatus);

/**
 * @openapi
 * /superadmin/revenue/summary:
 *   get:
 *     tags: [Super Admin]
 *     summary: Get subscription revenue summary
 *     security:
 *       - bearerAuth: []
 */
router.get('/revenue/summary', protect, superAdminOnly, listRevenueSummary);

/**
 * @openapi
 * /superadmin/revenue/payments:
 *   get:
 *     tags: [Super Admin]
 *     summary: List all subscription payments
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Super Admin]
 *     summary: Manually record a subscription payment
 *     security:
 *       - bearerAuth: []
 */
router.get('/revenue/payments', protect, superAdminOnly, listSubscriptionPayments);
router.post('/revenue/payments', protect, superAdminOnly, recordSubscriptionPayment);

/**
 * @openapi
 * /superadmin/ai/chat:
 *   post:
 *     tags: [Super Admin]
 *     summary: Chat with the superadmin AI assistant
 *     security:
 *       - bearerAuth: []
 */
router.post('/ai/chat', protect, superAdminOnly, handleSuperAdminChat);

/**
 * @openapi
 * /superadmin/catalog/modules:
 *   get: { tags: [Super Admin], summary: List add-on modules (catalog), security: [{ bearerAuth: [] }] }
 *   post: { tags: [Super Admin], summary: Create or update an add-on module, security: [{ bearerAuth: [] }] }
 */
router.get('/catalog/modules', protect, superAdminOnly, listCatalogModules);
router.post('/catalog/modules', protect, superAdminOnly, saveCatalogModule);
router.put('/catalog/modules/:id', protect, superAdminOnly, saveCatalogModule);
router.delete('/catalog/modules/:id', protect, superAdminOnly, removeCatalogModule);

/**
 * @openapi
 * /superadmin/catalog/plans:
 *   get: { tags: [Super Admin], summary: List subscription plans (catalog), security: [{ bearerAuth: [] }] }
 *   post: { tags: [Super Admin], summary: Create or update a subscription plan, security: [{ bearerAuth: [] }] }
 */
router.get('/catalog/plans', protect, superAdminOnly, listCatalogPlans);
router.post('/catalog/plans', protect, superAdminOnly, saveCatalogPlan);
router.put('/catalog/plans/:id', protect, superAdminOnly, saveCatalogPlan);
router.delete('/catalog/plans/:id', protect, superAdminOnly, removeCatalogPlan);

/**
 * @openapi
 * /superadmin/upsell-campaigns:
 *   get: { tags: [Super Admin], summary: List upsell campaigns (incl. drafts), security: [{ bearerAuth: [] }] }
 *   post: { tags: [Super Admin], summary: Create or update an upsell campaign, security: [{ bearerAuth: [] }] }
 */
router.get('/upsell-campaigns', protect, superAdminOnly, listCampaigns);
router.post('/upsell-campaigns', protect, superAdminOnly, saveCampaign);
router.put('/upsell-campaigns/:id', protect, superAdminOnly, saveCampaign);
router.delete('/upsell-campaigns/:id', protect, superAdminOnly, removeCampaign);

/**
 * @openapi
 * /superadmin/upsell-analytics:
 *   get: { tags: [Super Admin], summary: Upsell campaign funnel (per campaign + variant), security: [{ bearerAuth: [] }] }
 */
router.get('/upsell-analytics', protect, superAdminOnly, getUpsellAnalytics);

/**
 * @openapi
 * /superadmin/email-templates:
 *   get: { tags: [Super Admin], summary: List configurable email templates, security: [{ bearerAuth: [] }] }
 */
router.get('/email-templates', protect, superAdminOnly, listEmailTemplatesHandler);
router.post('/email-templates', protect, superAdminOnly, createEmailTemplateHandler);
router.put('/email-templates/:key', protect, superAdminOnly, updateEmailTemplateHandler);
router.delete('/email-templates/:key', protect, superAdminOnly, deleteEmailTemplateHandler);
router.post('/email-templates/:key/reset', protect, superAdminOnly, resetEmailTemplateHandler);
router.post('/email-templates/:key/preview', protect, superAdminOnly, previewEmailTemplateHandler);
router.post('/email-templates/:key/test', protect, superAdminOnly, testEmailTemplateHandler);

export default router;
