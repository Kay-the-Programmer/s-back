import express from 'express';
import { createOffer, getOffers, getOfferById, acceptOffer } from '../controllers/offers.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /offers:
 *   post:
 *     tags: [Offers]
 *     summary: Create a new offer
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               requestId: { type: string }
 *               price: { type: number }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Offer created
 *   get:
 *     tags: [Offers]
 *     summary: Get all offers
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of offers
 */
router.post('/', protect, createOffer);
router.get('/', protect, getOffers);

/**
 * @openapi
 * /offers/{id}:
 *   get:
 *     tags: [Offers]
 *     summary: Get an offer by ID
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:id', protect, getOfferById);

/**
 * @openapi
 * /offers/{id}/accept:
 *   post:
 *     tags: [Offers]
 *     summary: Accept an offer
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/:id/accept', protect, acceptOffer);

export default router;
