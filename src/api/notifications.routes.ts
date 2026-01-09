import express from 'express';
import { getStoreNotifications, markAsRead } from '../controllers/notifications.controller';

const router = express.Router();

router.get('/stores/:storeId', getStoreNotifications);
router.patch('/:id/read', markAsRead);

export default router;
