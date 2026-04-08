import express from 'express';
import { getAuditLogs } from '../controllers/audit.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /audit:
 *   get:
 *     tags: [Audit]
 *     summary: Get audit logs (admin only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of audit log entries
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id: { type: string }
 *                   timestamp: { type: string, format: date-time }
 *                   userId: { type: string }
 *                   userName: { type: string }
 *                   action: { type: string }
 *                   details: { type: string }
 */
router.get('/', protect, adminOnly, getAuditLogs);

export default router;