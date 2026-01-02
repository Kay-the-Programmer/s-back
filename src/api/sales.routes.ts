import express from 'express';
import { getSales, createSale, recordPayment } from '../controllers/sales.controller';
import { protect, canPerformSales } from '../middleware/auth.middleware';

const router = express.Router();

router.route('/')
    .get(protect, getSales)
    .post(protect, canPerformSales, createSale);

router.route('/:id/payments')
    .post(protect, canPerformSales, recordPayment);

export default router;