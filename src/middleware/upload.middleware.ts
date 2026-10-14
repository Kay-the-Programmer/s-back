import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Configure multer storage
const storage = multer.memoryStorage();

// File filter to accept only images.
//
// An allowlist, not `image/*`: the client picks this header, and `image/*` also
// admits image/svg+xml, which is a scriptable document rather than a flat
// image. This is a cheap first gate — the authoritative control is the stored
// extension (see storage.service), since that is what decides the Content-Type
// the file is later served with.
const ALLOWED_MIME = new Set([
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
]);

const fileFilter = (req: any, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    if (ALLOWED_MIME.has((file.mimetype || '').toLowerCase())) {
        cb(null, true);
    } else {
        cb(new Error('Only JPEG, PNG, GIF, WebP or AVIF images are allowed!'));
    }
};

// Configure multer
const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024, // 5MB limit
        files: 5 // Maximum 5 files
    }
});

export default upload;