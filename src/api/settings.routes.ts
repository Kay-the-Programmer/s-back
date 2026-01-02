import express from 'express';
import { getSettings, updateSettings } from '../controllers/settings.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();

router.route('/')
    .get(protect, getSettings) // All authenticated users can read settings
    .put(protect, adminOnly, updateSettings); // Only admins can change them

export default router;