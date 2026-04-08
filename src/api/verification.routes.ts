import { Router } from 'express';
import { uploadVerificationDocument, getVerificationStatus, verifyStore, verifyPhone } from '../controllers/verification.controller';
import { protect } from '../middleware/auth.middleware';

const router = Router();

/**
 * @openapi
 * /verification/upload:
 *   post:
 *     tags: [Verification]
 *     summary: Upload a verification document for the store
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               document:
 *                 type: string
 *                 format: binary
 */
router.post('/upload', protect, uploadVerificationDocument);

/**
 * @openapi
 * /verification/status:
 *   get:
 *     tags: [Verification]
 *     summary: Get the current store's verification status
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Verification status
 */
router.get('/status', protect, getVerificationStatus);

/**
 * @openapi
 * /verification/verify:
 *   post:
 *     tags: [Verification]
 *     summary: Submit a store for admin verification
 *     security:
 *       - bearerAuth: []
 */
router.post('/verify', protect, verifyStore);

/**
 * @openapi
 * /verification/verify-phone:
 *   post:
 *     tags: [Verification]
 *     summary: Verify a phone number via OTP
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               otp: { type: string }
 */
router.post('/verify-phone', protect, verifyPhone);

export default router;
