import express from 'express';
import { generateDescription, handleChat, generatePoster, proxyImage } from '../controllers/ai.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.post('/generate-description', protect, generateDescription);
router.post('/chat', protect as any, handleChat as any);
router.post('/generate-poster', protect, generatePoster);
router.get('/proxy-image', proxyImage);

export default router;