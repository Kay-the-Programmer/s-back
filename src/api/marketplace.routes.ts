import express from 'express';
import {
    createMarketplaceRequest,
    getRecentRequests,
    getRequestDetails,
    submitOffer,
    respondToOffer,
    getStorePendingMatches
} from '../controllers/marketplace.controller';

const router = express.Router();

// Public routes for customers
router.post('/requests', createMarketplaceRequest);
router.get('/requests/recent', getRecentRequests);
router.get('/requests/:id', getRequestDetails);
router.post('/offers/:offerId/respond', respondToOffer);

// Routes for sellers (authenticated in production, but keeping it simple for now)
router.post('/offers', submitOffer);
router.get('/stores/:storeId/matches', getStorePendingMatches);

export default router;
