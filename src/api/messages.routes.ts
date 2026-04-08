import express from 'express';
import { sendMessage, getMessages, upload } from '../controllers/messages.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * @openapi
 * /messages:
 *   post:
 *     tags: [Messages]
 *     summary: Send a message (with optional image attachment)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               offerId: { type: string }
 *               text: { type: string }
 *               image:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Message sent
 */
router.post('/', protect, upload.single('image'), sendMessage);

/**
 * @openapi
 * /messages/{offerId}:
 *   get:
 *     tags: [Messages]
 *     summary: Get all messages for a specific offer/conversation
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: offerId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: List of messages
 */
router.get('/:offerId', protect, getMessages);

export default router;
