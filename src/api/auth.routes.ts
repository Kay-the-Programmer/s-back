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
    verifyRegistration,
    resendVerificationEmail,
    resetPassword
} from '../controllers/auth.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Login a user
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string }
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token: { type: string }
 *                 user: { $ref: '#/components/schemas/User' }
 */
router.post('/login', loginUser);

/**
 * @openapi
 * /auth/google:
 *   post:
 *     tags: [Auth]
 *     summary: Login with Google
 */
router.post('/google', googleLogin);

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new admin user
 */
router.post('/register', registerUser);
router.post('/register-customer', registerCustomer);
router.post('/register-supplier', registerSupplier);

// Password Reset
router.post('/forgot-password', forgotPassword);
router.post('/reset-password', resetPassword);

// Email Verification
router.post('/verify-email', verifyEmail);
router.post('/verify-registration', verifyRegistration);
router.post('/resend-verification', protect, resendVerificationEmail); // Protected usually, or allow plain post if only email

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get current authenticated user
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Success
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 */
router.get('/me', protect, getCurrentUser);
router.post('/change-password', protect, changePassword);

export default router;