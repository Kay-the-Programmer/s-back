import express from 'express';
import { generateDescription, handleChat, generatePoster, proxyImage, getPlatformInsight, getAiUsage } from '../controllers/ai.controller';
import { protect } from '../middleware/auth.middleware';
import { checkAiLimit } from '../middleware/ai-limit.middleware';

const router = express.Router();

/**
 * @openapi
 * /ai/usage:
 *   get:
 *     tags: [AI]
 *     summary: Get AI usage statistics for the current store
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: AI usage data
 */
router.get('/usage', protect, getAiUsage);

/**
 * @openapi
 * /ai/generate-description:
 *   post:
 *     tags: [AI]
 *     summary: Generate a product description using AI
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               productName: { type: string }
 *     responses:
 *       200:
 *         description: Generated description
 */
router.post('/generate-description', protect, checkAiLimit, generateDescription);

/**
 * @openapi
 * /ai/chat:
 *   post:
 *     tags: [AI]
 *     summary: Chat with the AI assistant
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message: { type: string }
 */
router.post('/chat', protect as any, handleChat as any);

/**
 * @openapi
 * /ai/platform-insight:
 *   get:
 *     tags: [AI]
 *     summary: Get AI-generated platform insights
 *     security:
 *       - bearerAuth: []
 */
router.get('/platform-insight', protect as any, getPlatformInsight as any);

/**
 * @openapi
 * /ai/generate-poster:
 *   post:
 *     tags: [AI]
 *     summary: Generate a marketing poster using AI
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               productName: { type: string }
 *               description: { type: string }
 */
router.post('/generate-poster', protect, generatePoster);

/**
 * @openapi
 * /ai/proxy-image:
 *   get:
 *     tags: [AI]
 *     summary: Proxy an external image URL (public)
 *     parameters:
 *       - in: query
 *         name: url
 *         required: true
 *         schema:
 *           type: string
 */
router.get('/proxy-image', proxyImage);

export default router;