import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

/**
 * Desktop release binaries are nothing like the image uploads the rest of the
 * app handles, so they get their own multer instance:
 *
 *  - DISK storage, not memory. A desktop build is 50-300MB; buffering that in
 *    RAM (as `upload.middleware.ts` does for 5MB images) would blow the heap
 *    on a small VM with a couple of concurrent uploads.
 *  - Installer archives only, never images.
 *  - Written straight into the volume-mounted uploads dir so files survive a
 *    container rebuild, exactly like `storage.service`'s local fallback.
 *    Cloudinary is deliberately NOT used: it is an image CDN, and it would
 *    mangle a .zip.
 */

// __dirname is dist/middleware at runtime -> ../../uploads = app root/uploads
export const RELEASE_DIR = path.join(__dirname, '../../uploads/releases');

// .apk is the Android build. Note it is the one entry here that a browser will
// hand to an OS installer rather than a desktop download folder, which is why
// downloadRelease sends it with Android's own content type.
const ALLOWED_EXT = new Set(['.zip', '.msix', '.exe', '.dmg', '.appimage', '.deb', '.apk']);

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        fs.mkdir(RELEASE_DIR, { recursive: true }, err => cb(err, RELEASE_DIR));
    },
    // The stored name is generated server-side and never derived from user
    // input, so a crafted filename cannot escape RELEASE_DIR. The original
    // name is kept in the DB column and only used as a download label.
    filename: (_req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase();
        const safeExt = ALLOWED_EXT.has(ext) ? ext : '.zip';
        cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${safeExt}`);
    },
});

const fileFilter = (_req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
        return cb(new Error(`Unsupported installer type "${ext}". Allowed: ${[...ALLOWED_EXT].join(', ')}`));
    }
    cb(null, true);
};

// 500MB ceiling. NOTE: the reverse proxy in front of the API (Caddy) and any
// CDN also cap request bodies — raising this alone is not enough.
export const MAX_RELEASE_BYTES = 500 * 1024 * 1024;

const releaseUpload = multer({
    storage,
    fileFilter,
    limits: { fileSize: MAX_RELEASE_BYTES, files: 1 },
});

export default releaseUpload;
