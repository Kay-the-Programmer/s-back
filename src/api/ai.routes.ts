import express from 'express';
import { generateDescription } from '../controllers/ai.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.post('/generate-description', protect, generateDescription);

export default router;