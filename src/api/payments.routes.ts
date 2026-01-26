import { Router } from 'express';
import { verifyPayment, getBanks, handleLencoWebhook } from '../controllers/payment.controller';

const router = Router();

router.post('/lenco/verify', verifyPayment);
router.get('/lenco/banks', getBanks);
router.post('/lenco/webhook', handleLencoWebhook);

export default router;
