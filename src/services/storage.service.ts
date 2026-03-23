import { v2 as cloudinary } from 'cloudinary';
import streamifier from 'streamifier';
import dotenv from 'dotenv';

dotenv.config();

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

export const storageService = {
    async uploadFile(file: Express.Multer.File, folder: string = 'products'): Promise<string> {
        if (!process.env.CLOUDINARY_CLOUD_NAME) {
            console.warn('[Storage] Cloudinary is not configured. Returning dummy URL.');
            return `https://via.placeholder.com/800x800?text=Unconfigured+Cloudinary`;
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
