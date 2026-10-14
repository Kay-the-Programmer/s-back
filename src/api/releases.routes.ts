import express from 'express';
import { listPublishedReleases, getLatestRelease, downloadRelease } from '../controllers/releases.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * User-facing desktop downloads. Every route requires a session: the installer
 * is for existing customers, and gating it keeps the binary from being
 * hotlinked off the public internet. Super Admin upload/management lives in
 * `superadmin.routes.ts`.
 */

/**
 * @openapi
 * /releases/desktop:
 *   get:
 *     tags: [Downloads]
 *     summary: List published desktop releases
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: platform
 *         schema:
 *           type: string
 *           enum: [windows, mac, linux]
 *     responses:
 *       200:
 *         description: Published releases, newest first
 */
router.get('/desktop', protect, listPublishedReleases);

/**
 * @openapi
 * /releases/desktop/latest:
 *   get:
 *     tags: [Downloads]
 *     summary: The current desktop build for a platform
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: The latest published release
 *       404:
 *         description: Nothing published yet
 */
router.get('/desktop/latest', protect, getLatestRelease);

/**
 * @openapi
 * /releases/{id}/download:
 *   get:
 *     tags: [Downloads]
 *     summary: Download a release installer
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The installer file
 *       410:
 *         description: The file is missing from storage
 */
router.get('/:id/download', protect, downloadRelease);

export default router;
