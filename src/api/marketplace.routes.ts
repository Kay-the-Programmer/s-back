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

// Public routes for customers
router.post('/requests', createMarketplaceRequest);
router.get('/requests/recent', getRecentRequests);
router.get('/requests/:id', getRequestDetails);
router.get('/my-requests', protect, getCustomerRequests);
router.get('/my-orders', protect, getMyOrders);
router.post('/offers/:offerId/respond', respondToOffer);

// Routes for sellers (authenticated in production, but keeping it simple for now)
router.post('/offers', submitOffer);
router.get('/stores/:storeId/matches', getStorePendingMatches);

export default router;
