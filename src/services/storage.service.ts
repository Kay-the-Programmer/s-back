import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const isCloudinaryConfigured = () =>
    !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

// Local fallback storage. Served statically at /uploads (index.ts) and
// volume-mounted in docker-compose, so files survive container rebuilds.
// (__dirname is dist/services at runtime → ../../uploads = app root/uploads.)
const UPLOAD_ROOT = path.join(__dirname, '../../uploads');

const sanitizeSegment = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '') || 'misc';

const saveToLocalDisk = async (file: Express.Multer.File, folder: string): Promise<string> => {
    const safeFolder = sanitizeSegment(folder);
    const dir = path.join(UPLOAD_ROOT, safeFolder);
    await fs.promises.mkdir(dir, { recursive: true });

    const rawExt = path.extname(file.originalname || '').toLowerCase();
    const ext = /^\.[a-z0-9]{2,5}$/.test(rawExt) ? rawExt : '.jpg';
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}${ext}`;

    await fs.promises.writeFile(path.join(dir, name), file.buffer);
    const url = `/uploads/${safeFolder}/${name}`;
    console.log(`[Storage] Cloudinary not configured — saved locally: ${url}`);
    return url;
};

export const storageService = {
    async uploadFile(file: Express.Multer.File, folder: string = 'products'): Promise<string> {
        // No Cloudinary credentials → store on local disk instead of silently
        // returning a dead placeholder URL (which made every upload appear broken).
        if (!isCloudinaryConfigured()) {
            return saveToLocalDisk(file, folder);
        }

        return new Promise((resolve, reject) => {
            const uploadStream = cloudinary.uploader.upload_stream(
                {
                    folder: `salepilot/${folder}`,
                },
                (error, result) => {
                    if (error) {
                        console.error('[Storage] Error uploading file to Cloudinary:', error);
                        return reject(new Error('Failed to upload file'));
                    }
                    if (!result) {
                        return reject(new Error('No result from Cloudinary'));
                    }
                    console.log(`[Storage] File uploaded to Cloudinary: ${result.secure_url}`);
                    resolve(result.secure_url);
                }
            );
            streamifier.createReadStream(file.buffer).pipe(uploadStream);
        });
    },

    async deleteFile(fileUrl: string): Promise<void> {
        if (!fileUrl || typeof fileUrl !== 'string') return;

        try {
            // Skip base64
            if (fileUrl.startsWith('data:')) return;

            // Handle Cloudinary URLs
            // e.g. https://res.cloudinary.com/cloud_name/image/upload/v1234/salepilot/products/xyz.jpg
            if (fileUrl.includes('cloudinary.com')) {
                const splitUrl = fileUrl.split('/');
                const uploadIndex = splitUrl.findIndex(part => part === 'upload');

                if (uploadIndex !== -1 && uploadIndex + 2 < splitUrl.length) {
                    // Extract public_id starting after 'upload/v1234/'
                    const publicIdWithExt = splitUrl.slice(uploadIndex + 2).join('/');
                    const publicId = publicIdWithExt.split('.')[0]; // remove file extension

                    await cloudinary.uploader.destroy(publicId);
                    console.log(`[Storage] File deleted from Cloudinary: ${publicId}`);
                }
                return;
            }

            // Locally stored uploads: delete from disk, refusing any path that
            // resolves outside the uploads root.
            if (fileUrl.startsWith('/uploads/')) {
                const rel = fileUrl.slice('/uploads/'.length);
                const target = path.resolve(UPLOAD_ROOT, rel);
                if (!target.startsWith(path.resolve(UPLOAD_ROOT) + path.sep)) {
                    console.warn('[Storage] Refusing to delete outside uploads root:', fileUrl);
                    return;
                }
                await fs.promises.unlink(target).catch(() => { /* already gone */ });
                console.log(`[Storage] Local file deleted: ${fileUrl}`);
                return;
            }

            // Protect static assets
            if (fileUrl.startsWith('/images/')) {
                console.log('[Storage] Skipping delete - preserving static asset:', fileUrl);
                return;
            }

            console.log('[Storage] Skipping delete - unrecognized URL format:', fileUrl);
        } catch (error: any) {
            console.error('[Storage] Error deleting file:', error);
            // Don't throw to avoid blocking other operations
        }
    }
};
