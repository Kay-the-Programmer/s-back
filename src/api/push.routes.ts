
import express from 'express';
import * as pushController from '../controllers/push.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.get('/vapid-public-key', pushController.getVapidPublicKey);
router.post('/subscribe', pushController.subscribe);
router.post('/unsubscribe', pushController.unsubscribe);
router.post('/test', protect, pushController.sendTestNotification);

export default router;
