import express from 'express';
import {
    createMarketplaceRequest,
    getRecentRequests,
    getRequestDetails,
    submitOffer,
    respondToOffer,
    getStorePendingMatches,
    getCustomerRequests,
    getMyOrders
} from '../controllers/marketplace.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /marketplace/requests:
 *   post:
 *     tags: [Marketplace]
 *     summary: Create a new marketplace request (authenticated)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               productName: { type: string }
 *               quantity: { type: number }
 *               description: { type: string }
 */
router.post('/requests', protect, createMarketplaceRequest);

/**
 * @openapi
 * /marketplace/requests/recent:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get recent marketplace requests (public)
 *     responses:
 *       200:
 *         description: List of recent requests
 */
router.get('/requests/recent', getRecentRequests);

/**
 * @openapi
 * /marketplace/requests/{id}:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get marketplace request details (public)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/requests/:id', protect, getRequestDetails);

/**
 * @openapi
 * /marketplace/my-requests:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get the current customer's marketplace requests
 *     security:
 *       - bearerAuth: []
 */
router.get('/my-requests', protect, getCustomerRequests);

/**
 * @openapi
 * /marketplace/my-orders:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get the current user's marketplace orders
 *     security:
 *       - bearerAuth: []
 */
router.get('/my-orders', protect, getMyOrders);

/**
 * @openapi
 * /marketplace/offers/{offerId}/respond:
 *   post:
 *     tags: [Marketplace]
 *     summary: Respond to a marketplace offer
 *     parameters:
 *       - in: path
 *         name: offerId
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/offers/:offerId/respond', protect, respondToOffer);

/**
 * @openapi
 * /marketplace/offers:
 *   post:
 *     tags: [Marketplace]
 *     summary: Submit an offer for a marketplace request (seller)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               requestId: { type: string }
 *               price: { type: number }
 */
router.post('/offers', protect, submitOffer);

/**
 * @openapi
 * /marketplace/stores/{storeId}/matches:
 *   get:
 *     tags: [Marketplace]
 *     summary: Get pending matches for a store
 *     parameters:
 *       - in: path
 *         name: storeId
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/stores/:storeId/matches', protect, getStorePendingMatches);

export default router;
