import path from 'path';
import crypto from 'crypto';
import { adminStorage } from '../firebase';

export const storageService = {
    async uploadFile(file: Express.Multer.File, folder: string = 'products'): Promise<string> {
        if (!adminStorage) {
            throw new Error('[Storage] Firebase Admin Storage is not initialized. Ensure FIREBASE_SERVICE_ACCOUNT is set.');
        }

        try {
            // Generate unique filename
            const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
            const filename = `${name}-${uniqueSuffix}${ext}`;

            // Full path inside the Firebase Storage bucket
            const destination = `${folder}/${filename}`;
            const fileRef = adminStorage.file(destination);

            // Upload the buffer directly to Firebase Storage
            await fileRef.save(file.buffer, {
                metadata: {
                    contentType: file.mimetype,
                },
            });

            // Make the file publicly readable
            await fileRef.makePublic();

            // Return the public download URL
            const publicUrl = `https://storage.googleapis.com/${adminStorage.name}/${destination}`;
            console.log(`[Storage] File uploaded to Firebase Storage: ${publicUrl}`);
            return publicUrl;
        } catch (error) {
            console.error('[Storage] Error uploading file to Firebase Storage:', error);
            throw new Error('Failed to upload file');
        }
    },

    async deleteFile(fileUrl: string): Promise<void> {
        if (!fileUrl || typeof fileUrl !== 'string') return;

        try {
            // Skip base64 or clearly non-storage URLs
            if (fileUrl.startsWith('data:')) return;

            // Handle Firebase Storage URLs
            // e.g. https://storage.googleapis.com/bucket-name/folder/filename.jpg
            if (fileUrl.includes('storage.googleapis.com') && adminStorage) {
                const bucketName = adminStorage.name;
                const prefix = `https://storage.googleapis.com/${bucketName}/`;
                if (fileUrl.startsWith(prefix)) {
                    const filePath = fileUrl.slice(prefix.length);
                    try {
                        await adminStorage.file(filePath).delete();
                        console.log(`[Storage] File deleted from Firebase Storage: ${filePath}`);
                    } catch (err: any) {
                        if (err.code === 404) {
                            console.log(`[Storage] File not found or already deleted: ${filePath}`);
                        } else {
                            throw err;
                        }
                    }
                }
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
