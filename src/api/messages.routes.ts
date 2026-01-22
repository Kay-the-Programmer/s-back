import express from 'express';
import { sendMessage, getMessages, upload } from '../controllers/messages.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.post('/', protect, upload.single('image'), sendMessage);
router.get('/:offerId', protect, getMessages);

export default router;
