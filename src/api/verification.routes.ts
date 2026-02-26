import { Router } from 'express';
import { uploadVerificationDocument, getVerificationStatus, verifyStore, verifyPhone } from '../controllers/verification.controller';
import { protect } from '../middleware/auth.middleware';

const router = Router();

router.post('/upload', protect, uploadVerificationDocument);
router.get('/status', protect, getVerificationStatus);
router.post('/verify', protect, verifyStore);
router.post('/verify-phone', protect, verifyPhone);

export default router;
