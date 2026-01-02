import express from 'express';
import { registerStore } from '../controllers/stores.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// Register a new store for the current user and grant admin privileges
router.post('/register', protect, registerStore);

export default router;
