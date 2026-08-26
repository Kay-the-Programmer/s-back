import express from 'express';
import {
    addMovement,
    closeSession,
    getCurrentSession,
    getSessionReport,
    listSessions,
    openSession,
    recordNoSale,
} from '../controllers/cash-sessions.controller';
import { protect } from '../middleware/auth.middleware';
import { requirePermission } from '../auth/rbac';

const router = express.Router();

// Running a till is a cashier's job; reading what one *should* hold is not.
// The X report below is gated separately for that reason.
router.use(protect, requirePermission('cash:operate'));

/**
 * @openapi
 * /cash-sessions/current:
 *   get:
 *     tags: [Cash Sessions]
 *     summary: The caller's open till, or null. Never reveals expected cash.
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The open session, or null when none is open
 */
router.get('/current', getCurrentSession);

/**
 * @openapi
 * /cash-sessions:
 *   get:
 *     tags: [Cash Sessions]
 *     summary: Past till sessions. Own sessions only without cash:manage.
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Cash Sessions]
 *     summary: Open a till with a counted float
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Session opened
 *       409:
 *         description: This user already has a till open
 */
router.route('/')
    .get(listSessions)
    .post(openSession);

/**
 * @openapi
 * /cash-sessions/{id}/movements:
 *   post:
 *     tags: [Cash Sessions]
 *     summary: Record cash in or out that is not a sale
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/:id/movements', addMovement);

/**
 * @openapi
 * /cash-sessions/{id}/no-sale:
 *   post:
 *     tags: [Cash Sessions]
 *     summary: Record the drawer being opened without a sale
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/:id/no-sale', recordNoSale);

/**
 * @openapi
 * /cash-sessions/{id}/report:
 *   get:
 *     tags: [Cash Sessions]
 *     summary: X report — mid-shift totals including expected cash. Manager only.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/:id/report', requirePermission('cash:manage'), getSessionReport);

/**
 * @openapi
 * /cash-sessions/{id}/close:
 *   post:
 *     tags: [Cash Sessions]
 *     summary: Z report — submit a blind count and close the till
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.post('/:id/close', closeSession);

export default router;
