import express from 'express';
import {
    listPublishedReleases,
    getLatestRelease,
    downloadRelease,
    createDownloadTicket,
    downloadReleaseByTicket,
} from '../controllers/releases.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

/**
 * User-facing desktop downloads. Every route requires a session: the installer
 * is for existing customers, and gating it keeps the binary from being
 * hotlinked off the public internet. Super Admin upload/management lives in
 * `superadmin.routes.ts`.
 *
 * `/file/:token` is the one exception: it carries no session, because the
 * browser's own downloader makes that request and cannot send an Authorization
 * header. The single-use ticket minted by `/:id/download-token` is its entire
 * credential, so the binary is still not reachable without a signed-in user
 * having asked for it seconds earlier.
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

/**
 * @openapi
 * /releases/{id}/download-token:
 *   post:
 *     tags: [Downloads]
 *     summary: Mint a single-use, short-lived download URL
 *     description: >
 *       Returns a relative path containing an opaque ticket that is valid for
 *       two minutes, bound to this release and this user, and consumed by the
 *       first request that redeems it. The client hands the path to the browser
 *       so the file streams to disk instead of being buffered in memory.
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
 *         description: downloadPath, fileName, fileSize, expiresAt
 *       404:
 *         description: Release not found (or not published, for a non-superadmin)
 */
router.post('/:id/download-token', protect, createDownloadTicket);

/**
 * @openapi
 * /releases/file/{token}:
 *   get:
 *     tags: [Downloads]
 *     summary: Redeem a download ticket and stream the installer
 *     description: Intentionally unauthenticated — the ticket is the credential.
 *     parameters:
 *       - in: path
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: The installer file
 *       404:
 *         description: The ticket is unknown, expired or already used
 */
router.get('/file/:token', downloadReleaseByTicket);

export default router;
