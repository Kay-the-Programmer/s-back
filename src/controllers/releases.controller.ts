import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { RELEASE_DIR } from '../middleware/release-upload.middleware';

/**
 * App distribution — desktop installers and the Android APK.
 *
 * The table and the `/releases/desktop` paths are named for the desktop builds
 * that came first; both have always been keyed by `platform`, so Android rides
 * the same rows and endpoints rather than getting a parallel set. The names are
 * kept to avoid a migration and a client-breaking route rename.
 *
 * The Super Admin uploads an installer (one row per version/platform) and
 * publishes it; any signed-in user can then list published releases and
 * download the binary. The file is never served from /uploads directly — it
 * goes through `downloadRelease` so the filename, the published flag and the
 * download count are all enforced server-side.
 */

const PLATFORMS = ['windows', 'mac', 'linux', 'android'] as const;
const CHANNELS = ['stable', 'beta'] as const;

/**
 * Android will only hand a download to its package installer if it arrives as
 * application/vnd.android.package-archive. Express infers the type from the
 * filename, and its mime database does not know .apk, so without this the APK
 * is served as application/octet-stream and the phone just drops an opaque
 * file in Downloads that the user has to find and open by hand.
 */
const CONTENT_TYPE_BY_EXT: Record<string, string> = {
    '.apk': 'application/vnd.android.package-archive',
};

type Platform = (typeof PLATFORMS)[number];
type Channel = (typeof CHANNELS)[number];

/** Columns the client may see. `storage_path` is deliberately absent. */
const PUBLIC_COLS = `
    id, version, platform, channel, notes, file_name, file_size,
    checksum_sha256, is_published, download_count, created_at, updated_at
`;

const removeFileQuietly = async (storagePath: string | null | undefined) => {
    if (!storagePath) return;
    // basename() + containment check: a row whose storage_path was somehow
    // tampered with can never make us unlink outside the releases directory.
    const abs = path.resolve(RELEASE_DIR, path.basename(storagePath));
    if (!abs.startsWith(path.resolve(RELEASE_DIR))) return;
    try {
        await fs.promises.unlink(abs);
    } catch (e: any) {
        if (e?.code !== 'ENOENT') console.warn('[Releases] Could not remove file:', abs, e?.message);
    }
};

const sha256OfFile = (abs: string): Promise<string> =>
    new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(abs);
        stream.on('error', reject);
        stream.on('data', chunk => hash.update(chunk as Buffer));
        stream.on('end', () => resolve(hash.digest('hex')));
    });

/* ------------------------------------------------------------------ *
 * Super Admin
 * ------------------------------------------------------------------ */

/** Every release, published or not, newest first. */
export const listReleasesAdmin = async (_req: express.Request, res: express.Response) => {
    try {
        const { rows } = await db.query(
            `SELECT ${PUBLIC_COLS}, created_by FROM desktop_releases ORDER BY created_at DESC`
        );
        res.json(toCamelCase(rows));
    } catch (error) {
        console.error('[Releases] listReleasesAdmin failed:', error);
        res.status(500).json({ message: 'Failed to load releases' });
    }
};

/**
 * Upload a new installer. Multipart: `file` plus version/platform/channel/notes
 * fields. The row is created UNPUBLISHED so a bad upload is never visible to
 * users; publishing is a separate, deliberate step.
 */
export const uploadRelease = async (req: express.Request, res: express.Response) => {
    const file = req.file;
    try {
        const user = req.user;
        if (!file) return res.status(400).json({ message: 'No installer file was uploaded.' });

        const version = String(req.body?.version || '').trim();
        if (!version) {
            await removeFileQuietly(file.filename);
            return res.status(400).json({ message: 'A version is required (e.g. 1.4.0).' });
        }
        if (version.length > 40) {
            await removeFileQuietly(file.filename);
            return res.status(400).json({ message: 'Version is too long (max 40 characters).' });
        }

        const platform: Platform = PLATFORMS.includes(req.body?.platform) ? req.body.platform : 'windows';
        const channel: Channel = CHANNELS.includes(req.body?.channel) ? req.body.channel : 'stable';
        const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 5000) : null;

        // Extension and platform must agree. Nothing else cross-checks them, so
        // a mis-selected dropdown would otherwise publish an .apk on the Windows
        // tab (or an .exe on Android) and users would download something their
        // device cannot install.
        const ext = path.extname(file.originalname || '').toLowerCase();
        const mismatch =
            (ext === '.apk' && platform !== 'android') ||
            (ext !== '.apk' && platform === 'android');
        if (mismatch) {
            await removeFileQuietly(file.filename);
            return res.status(400).json({
                message: ext === '.apk'
                    ? 'An .apk is an Android build — set the platform to Android.'
                    : `Android builds must be .apk files (got "${ext}").`,
            });
        }

        const dup = await db.query(
            'SELECT id FROM desktop_releases WHERE platform = $1 AND version = $2',
            [platform, version]
        );
        if (dup.rows.length) {
            await removeFileQuietly(file.filename);
            return res.status(409).json({ message: `Version ${version} already exists for ${platform}.` });
        }

        // Checksum so a user can verify the download, and so a truncated upload
        // is detectable rather than silently shipped.
        const checksum = await sha256OfFile(path.join(RELEASE_DIR, file.filename));

        const id = generateId('rel');
        const { rows } = await db.query(
            `INSERT INTO desktop_releases
                (id, version, platform, channel, notes, file_name, storage_path, file_size, checksum_sha256, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
             RETURNING ${PUBLIC_COLS}`,
            [id, version, platform, channel, notes, file.originalname, file.filename, file.size, checksum, user?.id || null]
        );

        await auditService
            .log(user!, 'App Release Uploaded', `${platform} ${channel} ${version} (${file.originalname})`)
            .catch(() => {});

        res.status(201).json(toCamelCase(rows[0]));
    } catch (error) {
        console.error('[Releases] uploadRelease failed:', error);
        await removeFileQuietly(file?.filename);
        res.status(500).json({ message: 'Failed to save the release' });
    }
};

/**
 * Publish / unpublish, or edit the notes. Publishing a release automatically
 * unpublishes the previous one for the same platform+channel, so "latest" is
 * never ambiguous and users are never offered two current builds.
 */
export const updateRelease = async (req: express.Request, res: express.Response) => {
    const client = await db._pool.connect();
    try {
        const { id } = req.params;
        const user = req.user;

        const existing = await client.query('SELECT * FROM desktop_releases WHERE id = $1', [id]);
        if (!existing.rows.length) {
            return res.status(404).json({ message: 'Release not found' });
        }
        const row = existing.rows[0];

        const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim().slice(0, 5000) : row.notes;
        const isPublished = typeof req.body?.isPublished === 'boolean' ? req.body.isPublished : row.is_published;

        await client.query('BEGIN');
        if (isPublished && !row.is_published) {
            await client.query(
                `UPDATE desktop_releases SET is_published = FALSE, updated_at = NOW()
                 WHERE platform = $1 AND channel = $2 AND id <> $3 AND is_published = TRUE`,
                [row.platform, row.channel, id]
            );
        }
        const { rows } = await client.query(
            `UPDATE desktop_releases SET notes = $1, is_published = $2, updated_at = NOW()
             WHERE id = $3 RETURNING ${PUBLIC_COLS}`,
            [notes, isPublished, id]
        );
        await client.query('COMMIT');

        if (isPublished !== row.is_published) {
            await auditService
                .log(
                    user!,
                    isPublished ? 'App Release Published' : 'App Release Unpublished',
                    `${row.platform} ${row.version}`
                )
                .catch(() => {});
        }

        res.json(toCamelCase(rows[0]));
    } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[Releases] updateRelease failed:', error);
        res.status(500).json({ message: 'Failed to update the release' });
    } finally {
        client.release();
    }
};

/** Delete a release and its file. */
export const deleteRelease = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const user = req.user;

        const { rows } = await db.query('DELETE FROM desktop_releases WHERE id = $1 RETURNING *', [id]);
        if (!rows.length) return res.status(404).json({ message: 'Release not found' });

        await removeFileQuietly(rows[0].storage_path);
        await auditService
            .log(user!, 'App Release Deleted', `${rows[0].platform} ${rows[0].version}`)
            .catch(() => {});

        res.json({ success: true });
    } catch (error) {
        console.error('[Releases] deleteRelease failed:', error);
        res.status(500).json({ message: 'Failed to delete the release' });
    }
};

/* ------------------------------------------------------------------ *
 * Any signed-in user
 * ------------------------------------------------------------------ */

/** Published releases only, newest first. */
export const listPublishedReleases = async (req: express.Request, res: express.Response) => {
    try {
        const platform = PLATFORMS.includes(req.query?.platform as Platform)
            ? (req.query.platform as Platform)
            : null;

        const { rows } = await db.query(
            `SELECT ${PUBLIC_COLS} FROM desktop_releases
             WHERE is_published = TRUE AND ($1::text IS NULL OR platform = $1)
             ORDER BY created_at DESC`,
            [platform]
        );
        res.json(toCamelCase(rows));
    } catch (error) {
        console.error('[Releases] listPublishedReleases failed:', error);
        res.status(500).json({ message: 'Failed to load downloads' });
    }
};

/** The current build for a platform (defaults to windows / stable). */
export const getLatestRelease = async (req: express.Request, res: express.Response) => {
    try {
        const platform: Platform = PLATFORMS.includes(req.query?.platform as Platform)
            ? (req.query.platform as Platform)
            : 'windows';
        const channel: Channel = CHANNELS.includes(req.query?.channel as Channel)
            ? (req.query.channel as Channel)
            : 'stable';

        const { rows } = await db.query(
            `SELECT ${PUBLIC_COLS} FROM desktop_releases
             WHERE is_published = TRUE AND platform = $1 AND channel = $2
             ORDER BY created_at DESC LIMIT 1`,
            [platform, channel]
        );
        if (!rows.length) return res.status(404).json({ message: 'No published release yet' });
        res.json(toCamelCase(rows[0]));
    } catch (error) {
        console.error('[Releases] getLatestRelease failed:', error);
        res.status(500).json({ message: 'Failed to load the latest release' });
    }
};

/** How long a minted download ticket stays redeemable. */
const DOWNLOAD_TICKET_TTL_MS = 2 * 60 * 1000;

/**
 * Resolve a release to a file on disk, enforcing the published rule. Returns an
 * HTTP status + message instead of throwing so the token-redeeming and the
 * authenticated path answer identically.
 */
const resolveReleaseFile = async (
    id: string,
    isSuperAdmin: boolean
): Promise<{ ok: true; row: any; abs: string } | { ok: false; status: number; message: string }> => {
    const { rows } = await db.query('SELECT * FROM desktop_releases WHERE id = $1', [id]);
    if (!rows.length) return { ok: false, status: 404, message: 'Release not found' };

    const row = rows[0];
    // An unpublished build is visible to a Super Admin only — and answers with
    // the same 404 as a missing row, so its existence is not leaked.
    if (!row.is_published && !isSuperAdmin) return { ok: false, status: 404, message: 'Release not found' };

    // basename() strips any directory part before we touch the filesystem.
    const abs = path.resolve(RELEASE_DIR, path.basename(row.storage_path));
    if (!abs.startsWith(path.resolve(RELEASE_DIR)) || !fs.existsSync(abs)) {
        console.error('[Releases] File missing on disk for release', id, row.storage_path);
        return { ok: false, status: 410, message: 'This download is no longer available. Please contact support.' };
    }
    return { ok: true, row, abs };
};

/** Send the file, stamping the Android content type and bumping the counter. */
const streamReleaseFile = (res: express.Response, row: any, abs: string) => {
    // Counted before streaming: a cancelled download still signals intent,
    // and completion cannot be detected reliably anyway.
    db.query('UPDATE desktop_releases SET download_count = download_count + 1 WHERE id = $1', [row.id])
        .catch((e: any) => console.warn('[Releases] download_count bump failed:', e?.message));

    const explicitType = CONTENT_TYPE_BY_EXT[path.extname(row.file_name || '').toLowerCase()];
    if (explicitType) res.type(explicitType);

    res.download(abs, row.file_name, err => {
        if (err && !res.headersSent) {
            console.error('[Releases] download stream failed:', err);
            res.status(500).end();
        }
    });
};

/**
 * Mint a single-use download ticket for the caller.
 *
 * The download has to be authenticated, but a bearer header rules out the
 * browser's native downloader, and buffering a 300MB installer (or an APK on a
 * phone) into a Blob to work around that is exactly how a download silently
 * dies on a failed allocation. So the client asks for a ticket here — a
 * 32-byte opaque random value, good for two minutes, bound to this release and
 * this user, single-use — and hands the plain URL to the browser, which
 * streams straight to disk with its own progress and resume.
 *
 * This is deliberately NOT the session JWT: that must never reach a URL, where
 * it would sit in proxy and server access logs with 30 days of life left in it.
 */
export const createDownloadTicket = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const user = req.user;
        if (!user?.id) return res.status(401).json({ message: 'Not authenticated' });

        // Authorization is settled here, at mint time, by the same rule the
        // authenticated endpoint applies.
        const resolved = await resolveReleaseFile(id, user.role === 'superadmin');
        if (!resolved.ok) return res.status(resolved.status).json({ message: resolved.message });

        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + DOWNLOAD_TICKET_TTL_MS);
        await db.query(
            `INSERT INTO release_download_tokens (token, release_id, user_id, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [token, id, user.id, expiresAt]
        );

        // Opportunistic sweep so the table cannot grow without bound; nothing
        // depends on it succeeding.
        db.query("DELETE FROM release_download_tokens WHERE expires_at < NOW() - INTERVAL '1 day'")
            .catch(() => {});

        res.json({
            downloadPath: `/releases/file/${token}`,
            fileName: resolved.row.file_name,
            fileSize: Number(resolved.row.file_size),
            expiresAt: expiresAt.toISOString(),
        });
    } catch (error) {
        console.error('[Releases] createDownloadTicket failed:', error);
        res.status(500).json({ message: 'Failed to prepare the download' });
    }
};

/**
 * Redeem a ticket and stream the file. Unauthenticated by necessity — the
 * browser makes this request on its own — so the ticket is the whole
 * credential, and a caller without one gets nothing.
 */
export const downloadReleaseByTicket = async (req: express.Request, res: express.Response) => {
    const invalid = { message: 'This download link is invalid or has expired.' };
    try {
        const { token } = req.params;
        if (!token || token.length > 128) return res.status(404).json(invalid);

        const claimed = await db.query(
            `SELECT release_id, user_id FROM release_download_tokens
             WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()`,
            [token]
        );
        if (!claimed.rows.length) return res.status(404).json(invalid);

        const { release_id: releaseId, user_id: userId } = claimed.rows[0];

        // The minting user's role is read fresh: a release can be unpublished,
        // or a user demoted, between minting and redeeming.
        const userRes = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
        const isSuperAdmin = userRes.rows[0]?.role === 'superadmin';

        const resolved = await resolveReleaseFile(releaseId, isSuperAdmin);
        if (!resolved.ok) return res.status(resolved.status).json({ message: resolved.message });

        // Burned last, and atomically: the UPDATE only matches a row that is
        // still unused and unexpired, so two concurrent requests carrying the
        // same token cannot both get a file, and a token is not consumed by a
        // request that was going to fail anyway.
        const burn = await db.query(
            `UPDATE release_download_tokens SET used_at = NOW()
             WHERE token = $1 AND used_at IS NULL AND expires_at > NOW()
             RETURNING token`,
            [token]
        );
        if (!burn.rows.length) return res.status(404).json(invalid);

        streamReleaseFile(res, resolved.row, resolved.abs);
    } catch (error) {
        console.error('[Releases] downloadReleaseByTicket failed:', error);
        res.status(500).json({ message: 'Failed to download the release' });
    }
};

/**
 * Stream the installer with a session token. Kept for the desktop updater and
 * any older client; the web app mints a ticket above instead. An unpublished
 * release is downloadable by a Super Admin only.
 */
export const downloadRelease = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const resolved = await resolveReleaseFile(id, req.user?.role === 'superadmin');
        if (!resolved.ok) return res.status(resolved.status).json({ message: resolved.message });
        streamReleaseFile(res, resolved.row, resolved.abs);
    } catch (error) {
        console.error('[Releases] downloadRelease failed:', error);
        res.status(500).json({ message: 'Failed to download the release' });
    }
};
