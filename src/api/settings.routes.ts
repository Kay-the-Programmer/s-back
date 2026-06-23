import express from 'express';
import { getSettings, updateSettings } from '../controllers/settings.controller';
import { protect, adminOnly, requirePermission } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /settings:
 *   get:
 *     tags: [Settings]
 *     summary: Get store settings
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Store settings object
 *   put:
 *     tags: [Settings]
 *     summary: Update store settings (admin only)
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
 *               taxRate: { type: number }
 *               currency:
 *                 type: object
 *                 properties:
 *                   symbol: { type: string }
 *                   code: { type: string }
 *                   position: { type: string, enum: [before, after] }
 *     responses:
 *       200:
 *         description: Updated settings
 */
router.route('/')
    .get(protect, requirePermission('settings:read'), getSettings)
    .put(protect, adminOnly, updateSettings);

export default router;