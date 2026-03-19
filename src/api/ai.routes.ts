import express from 'express';
import { generateDescription, handleChat, generatePoster, proxyImage, getPlatformInsight, getAiUsage } from '../controllers/ai.controller';
import { protect } from '../middleware/auth.middleware';
import { checkAiLimit } from '../middleware/ai-limit.middleware';

const router = express.Router();

router.get('/usage', protect, getAiUsage);
router.post('/generate-description', protect, checkAiLimit, generateDescription);
router.post('/chat', protect as any, handleChat as any);
router.get('/platform-insight', protect as any, getPlatformInsight as any);
router.post('/generate-poster', protect, generatePoster);
router.get('/proxy-image', proxyImage);

export default router;