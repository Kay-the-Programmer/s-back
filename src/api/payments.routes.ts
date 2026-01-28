import { Router } from 'express';
import { verifyPayment, getBanks, handleLencoWebhook, initiatePayment, chargeMobileMoney, cancelPayment } from '../controllers/payment.controller';

const router = Router();

router.post('/lenco/verify', verifyPayment);
router.get('/lenco/banks', getBanks);
router.post('/lenco/webhook', handleLencoWebhook);
router.post('/lenco/initiate', initiatePayment);
router.post('/lenco/charge-mobile-money', chargeMobileMoney);
router.post('/lenco/cancel', cancelPayment);

export default router;
