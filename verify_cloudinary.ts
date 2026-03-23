import { storageService } from './src/services/storage.service';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '.env') });

async function verify() {
    console.log('[Verification] Starting Cloudinary upload test...');
    
    // Create a very small, simple 1x1 raw image buffer (just random bytes for testing)
    const buffer = Buffer.from('89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000A49444154789C63000100000500010D0A2DB40000000049454E44AE426082', 'hex');
    
    const mockFile: Express.Multer.File = {
        fieldname: 'test',
        originalname: 'test_image.png',
        encoding: '7bit',
        mimetype: 'image/png',
        buffer: buffer,
        size: buffer.length,
        destination: '',
        filename: 'test_image.png',
        path: '',
        stream: null as any
    };

    try {
        console.log('[Verification] Uploading to Cloudinary...');
        const url = await storageService.uploadFile(mockFile, 'test');
        console.log(`[Verification] SUCCESS! File uploaded successfully.`);
        console.log(`[Verification] Cloudinary URL: ${url}`);
        
        console.log('\n[Verification] Attempting to clean up (delete) test file...');
        await storageService.deleteFile(url);
        console.log('[Verification] SUCCESS! Test file deleted.');
        
        process.exit(0);
    } catch (error) {
        console.error('[Verification] FAILED: error during upload or delete process.', error);
        process.exit(1);
    }
}

verify();
