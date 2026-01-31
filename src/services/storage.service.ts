import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

// Get the uploads directory path
const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Ensure uploads directory exists
const ensureUploadsDirExists = (folder: string) => {
    const fullPath = path.join(UPLOADS_DIR, folder);
    if (!fs.existsSync(fullPath)) {
        fs.mkdirSync(fullPath, { recursive: true });
    }
    return fullPath;
};

export const storageService = {
    async uploadFile(file: Express.Multer.File, folder: string = 'products'): Promise<string> {
        try {
            // Ensure the folder exists
            const uploadPath = ensureUploadsDirExists(folder);

            // Generate unique filename
            const uniqueSuffix = Date.now() + '-' + crypto.randomBytes(8).toString('hex');
            const ext = path.extname(file.originalname);
            const name = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9-_]/g, '_');
            const filename = `${name}-${uniqueSuffix}${ext}`;
            const filePath = path.join(uploadPath, filename);

            // Write the file buffer to disk
            await fs.promises.writeFile(filePath, file.buffer);

            // Return the URL path that will be served by Express static middleware
            // This assumes the backend serves /uploads as static files
            const relativePath = `/uploads/${folder}/${filename}`;

            console.log(`[Storage] File uploaded successfully: ${relativePath}`);
            return relativePath;
        } catch (error) {
            console.error('Error uploading file to local storage:', error);
            throw new Error('Failed to upload file');
        }
    },

    async deleteFile(fileUrl: string): Promise<void> {
        try {
            // Handle empty or invalid URLs
            if (!fileUrl || typeof fileUrl !== 'string') {
                return;
            }

            // Skip URLs that are not local uploads (e.g., external URLs, base64)
            if (fileUrl.startsWith('data:') || fileUrl.includes('://')) {
                return;
            }

            // Protect static assets in checking public/images
            if (fileUrl.startsWith('/images/')) {
                console.log('[Storage] Skipping delete - preserving static asset:', fileUrl);
                return;
            }

            // Only handle local uploads paths
            if (!fileUrl.startsWith('/uploads/')) {
                console.log('[Storage] Skipping delete - not a local upload path:', fileUrl);
                return;
            }

            // Convert URL path to file system path
            // Remove '/uploads/' prefix to get relative path within UPLOADS_DIR
            const relativePath = fileUrl.replace(/^\/uploads\//, '');
            // Prevent directory traversal attacks
            const filePath = path.join(UPLOADS_DIR, relativePath);

            // Verify the resolved path is still within UPLOADS_DIR
            if (!filePath.startsWith(UPLOADS_DIR)) {
                console.warn(`[Storage] Security Warning: Attempted directory traversal deletion: ${fileUrl}`);
                return;
            }

            // Check if file exists before attempting to delete
            // Using fs.stat to check existence and ensure it's a file
            try {
                const stats = await fs.promises.stat(filePath);
                if (stats.isFile()) {
                    await fs.promises.unlink(filePath);
                    console.log(`[Storage] File deleted successfully: ${fileUrl}`);
                }
            } catch (err: any) {
                if (err.code === 'ENOENT') {
                    // File already gone, which is fine
                    console.log(`[Storage] File not found or already deleted: ${fileUrl}`);
                } else {
                    throw err;
                }
            }
        } catch (error: any) {
            console.error('Error deleting file from local storage:', error);
            // Don't throw here to avoid blocking other operations
        }
    }
};
