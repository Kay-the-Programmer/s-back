import express from 'express';
import {
    submitFeedback,
    listFeedback,
    getFeedbackStats,
    updateFeedback,
} from '../controllers/feedback.controller';
import { protect, superAdminOnly } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /feedback:
 *   post:
 *     tags: [Feedback]
 *     summary: Submit product feedback (any authenticated user)
 *     security:
 *       - bearerAuth: []
 *   get:
 *     tags: [Feedback]
 *     summary: List all feedback (Super Admin)
 *     security:
 *       - bearerAuth: []
 */
router.post('/', protect, submitFeedback);
router.get('/', protect, superAdminOnly, listFeedback);

/**
 * @openapi
 * /feedback/stats:
 *   get:
 *     tags: [Feedback]
 *     summary: Aggregate feedback analytics (Super Admin)
 *     security:
 *       - bearerAuth: []
 */
router.get('/stats', protect, superAdminOnly, getFeedbackStats);

/**
 * @openapi
 * /feedback/{id}:
 *   patch:
 *     tags: [Feedback]
 *     summary: Triage feedback — update status and/or admin notes (Super Admin)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 */
router.patch('/:id', protect, superAdminOnly, updateFeedback);

export default router;
