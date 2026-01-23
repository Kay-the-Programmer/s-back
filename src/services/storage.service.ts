import { storage, adminStorage } from '../firebase';
import { ref, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage';
import path from 'path';

export const storageService = {
    async uploadFile(file: Express.Multer.File, folder: string = 'products'): Promise<string> {
        // Try Admin SDK first (more reliable for backend)
        if (adminStorage) {
            try {
                const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
                const ext = path.extname(file.originalname);
                const name = path.basename(file.originalname, ext);
                const filename = `${folder}/${name}-${uniqueSuffix}${ext}`;
                const fileRef = adminStorage.file(filename);

                await fileRef.save(file.buffer, {
                    metadata: { contentType: file.mimetype },
                    resumable: false
                });

                // Make the file public and get the public URL
                await fileRef.makePublic();

                // Return the public URL
                // Note: encoding the filename might be needed if it has special chars, but for now we trust the constructed name.
                // const publicUrl = `https://storage.googleapis.com/${adminStorage.name}/${filename}`;
                // Or use the getPublicUrl() method if available, but constructing is reliable for GCS.
                // Ensure filename is URL encoded for the path part if needed.
                return `https://storage.googleapis.com/${adminStorage.name}/${encodeURI(filename)}`;

            } catch (error) {
                console.error('Error uploading file via Admin SDK:', error);
                // If Admin SDK fails (e.g. bad creds), fall through to Client SDK? 
                // Better to throw to avoid partial states, users should fix the creds.
                // But for resilience during migration, let's fall through if it was just a config issue, 
                // but usually if it's initialized it should work. 
                // Let's fallback only if adminStorage was null, but here we cover errors too to be safe?
                // No, let's rely on the Client SDK fallback ONLY if adminStorage is NOT initialized.
                // If it IS initialized but fails, it's a real error.
                throw new Error('Failed to upload file via Admin SDK');
            }
        }

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
            console.error('Error uploading file to Firebase Storage (Client SDK):', error);
            throw new Error('Failed to upload file');
        }
    },

    async deleteFile(fileUrl: string): Promise<void> {
        try {
            // Handle Google Cloud Storage URLs (Admin SDK)
            if (fileUrl.includes('storage.googleapis.com')) {
                // Format: https://storage.googleapis.com/BUCKET_NAME/folder/filename
                const urlObj = new URL(fileUrl);
                // pathname is /BUCKET_NAME/folder/filename
                // We need to strip /BUCKET_NAME/ to get folder/filename
                // But wait, adminStorage.name is the bucket name.

                const pathParts = urlObj.pathname.split('/');
                // pathParts[0] is empty, [1] is bucket, rest is path
                if (pathParts.length >= 3) {
                    const bucketName = pathParts[1];
                    // Verify bucket matches? Maybe not necessary if we trust the URL.
                    const storagePath = decodeURIComponent(pathParts.slice(2).join('/'));

                    if (adminStorage) {
                        await adminStorage.file(storagePath).delete();
                        return;
                    }
                }
            }

            // Handle Firebase Storage URLs (Client SDK)
            // fileUrl is like: https://firebasestorage.googleapis.com/v0/b/bucket-name/o/folder%2Ffilename?alt=...

            const urlObj = new URL(fileUrl);
            const pathName = urlObj.pathname; // /v0/b/bucket-name/o/folder%2Ffilename

            // Decode the path
            const decodedPath = decodeURIComponent(pathName);

            // The path in storage starts after /o/
            const parts = decodedPath.split('/o/');
            if (parts.length < 2) return; // Not a standard firebase storage URL?

            const storagePath = parts[1];

            if (adminStorage) {
                // We can use Admin SDK to delete this too!
                await adminStorage.file(storagePath).delete();
            } else {
                const storageRef = ref(storage, storagePath);
                await deleteObject(storageRef);
            }
        } catch (error: any) {
            // Ignore if object not found
            if (error.code === 'storage/object-not-found' || error.code === 404) {
                return;
            }
            console.error('Error deleting file from Firebase Storage:', error);
            // Don't throw here to avoid blocking other operations
        }
    }
};
