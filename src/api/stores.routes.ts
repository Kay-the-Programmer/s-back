import express from 'express';
import { registerStore, checkStoreName, verifyStoreRegistration, requestStoreSetupOtp, getMyStores, switchStore } from '../controllers/stores.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

// Multi-Store Manager: list the user's businesses + switch the active one.
router.get('/mine', protect, getMyStores);
router.post('/switch', protect, switchStore);

/**
 * @openapi
 * /stores/check-name:
 *   get:
 *     tags: [Stores]
 *     summary: Check if a store name is already taken
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: name
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Name availability status
 */
router.get('/check-name', protect, checkStoreName);

/**
 * @openapi
 * /stores/request-otp:
 *   post:
 *     tags: [Stores]
 *     summary: Email a verification code for store setup (creates no store)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *     responses:
 *       200:
 *         description: Verification code sent
 */
router.post('/request-otp', protect, requestStoreSetupOtp);

/**
 * @openapi
 * /stores/register:
 *   post:
 *     tags: [Stores]
 *     summary: Register a new store for the current user
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string }
 *               address: { type: string }
 *     responses:
 *       201:
 *         description: Store registered
 */
router.post('/register', protect, registerStore);

/**
 * @openapi
 * /stores/verify:
 *   post:
 *     tags: [Stores]
 *     summary: Verify a newly registered store
 *     security:
 *       - bearerAuth: []
 */
router.post('/verify', protect, verifyStoreRegistration);

export default router;
