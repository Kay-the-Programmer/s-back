import express from 'express';
import { getReturns, createReturn } from '../controllers/returns.controller';
import { protect, canPerformSales } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect, canPerformSales);

router.route('/')
    .get(getReturns)
    .post(createReturn);

export default router;