import { storage } from '../firebase';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import path from 'path';

export const storageService = {
    async uploadFile(file: Express.Multer.File, folder: string = 'products'): Promise<string> {
        try {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext);
            const filename = `${name}-${uniqueSuffix}${ext}`;

            const storageRef = ref(storage, `${folder}/${filename}`);

            const metadata = {
                contentType: file.mimetype,
            };

            await uploadBytes(storageRef, file.buffer, metadata);
            const downloadURL = await getDownloadURL(storageRef);

            return downloadURL;
        } catch (error) {
            console.error('Error uploading file to Firebase Storage:', error);
            throw new Error('Failed to upload file');
        }
    },

    async deleteFile(fileUrl: string): Promise<void> {
        try {
            // fileUrl is like: https://firebasestorage.googleapis.com/v0/b/bucket-name/o/folder%2Ffilename?alt=...
            // We need to extract the path 'folder/filename'

            const urlObj = new URL(fileUrl);
            const pathName = urlObj.pathname; // /v0/b/bucket-name/o/folder%2Ffilename

            // Decode the path
            const decodedPath = decodeURIComponent(pathName);

            // The path in storage starts after /o/
            const storagePath = decodedPath.split('/o/')[1];

            if (!storagePath) {
                console.warn('Could not extract storage path from URL:', fileUrl);
                return;
            }

            const storageRef = ref(storage, storagePath);
            await deleteObject(storageRef);
        } catch (error: any) {
            // Ignore if object not found
            if (error.code === 'storage/object-not-found') {
                return;
            }
            console.error('Error deleting file from Firebase Storage:', error);
            // Don't throw here to avoid blocking other operations
        }
    }
};
