import express from 'express';
import { getSales, createSale, recordPayment, updateFulfillmentStatus } from '../controllers/sales.controller';
import { protect, canPerformSales } from '../middleware/auth.middleware';

const router = express.Router();

router.route('/')
    .get(protect, getSales)
    .post(protect, canPerformSales, createSale);

router.route('/:id/payments')
    .post(protect, canPerformSales, recordPayment);

router.route('/:id/fulfillment')
    .put(protect, canPerformSales, updateFulfillmentStatus);

export default router;