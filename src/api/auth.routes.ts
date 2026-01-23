import express from 'express';
// ... imports
import {
    loginUser,
    registerUser,
    registerCustomer,
    registerSupplier,
    getCurrentUser,
    forgotPassword,
    changePassword,
    googleLogin,
    verifyEmail,
    resendVerificationEmail,
    resetPassword
} from '../controllers/auth.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.post('/login', loginUser);
router.post('/google', googleLogin);
router.post('/register', registerUser);
router.post('/register-customer', registerCustomer);
router.post('/register-supplier', registerSupplier);

// Password Reset
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Email Verification
router.post('/verify-email', verifyEmail);
router.post('/resend-verification', protect, resendVerificationEmail); // Protected usually, or allow plain post if only email

router.get('/me', protect, getCurrentUser);
router.post('/change-password', protect, changePassword);

export default router;