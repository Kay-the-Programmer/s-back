import express from 'express';
import { registerStore, checkStoreName, verifyStoreRegistration } from '../controllers/stores.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// Check if a store name is already taken
router.get('/check-name', protect, checkStoreName);

// Register a new store for the current user and grant admin privileges
router.post('/register', protect, registerStore);

// Verify a newly registered store
router.post('/verify', protect, verifyStoreRegistration);

export default router;
