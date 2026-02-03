import express from 'express';
import { getStoreNotifications, markAsRead, createLowStockNotification } from '../controllers/notifications.controller';

const router = express.Router();

router.get('/stores/:storeId', getStoreNotifications);
router.post('/low-stock', createLowStockNotification);
router.patch('/:id/read', markAsRead);

export default router;
