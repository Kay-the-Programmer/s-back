import express from 'express';
import { createOffer, getOffers, getOfferById, acceptOffer } from '../controllers/offers.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.post('/', protect, createOffer);
router.get('/', protect, getOffers);
router.get('/:id', protect, getOfferById);
router.post('/:id/accept', protect, acceptOffer);

export default router;
