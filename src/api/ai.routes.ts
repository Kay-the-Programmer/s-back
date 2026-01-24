import express from 'express';
import { generateDescription, handleChat } from '../controllers/ai.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.post('/generate-description', protect, generateDescription);
router.post('/chat', protect as any, handleChat as any);

export default router;