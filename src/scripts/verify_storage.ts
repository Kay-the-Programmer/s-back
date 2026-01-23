
import { adminStorage } from '../firebase';
import path from 'path';

async function verifyStorage() {
    console.log('--- Starting Firebase Storage Verification ---');

    if (!adminStorage) {
        console.error('[ERROR] adminStorage is not initialized. Check your .env credentials.');
        process.exit(1);
    }
    console.log(`[SUCCESS] Admin Storage initialized. Bucket: ${adminStorage.name}`);

    const folder = 'products';

    // 1. List existing files
    try {
        console.log(`\n--- Listing latest 5 files in '${folder}/' ---`);
        const [files] = await adminStorage.getFiles({ prefix: folder + '/', maxResults: 5 });

        if (files.length === 0) {
            console.log(`[INFO] No files found in '${folder}/'. This might be normal if no products have been created yet.`);
        } else {
            files.forEach((file: any) => {
                console.log(`- ${file.name} (${file.metadata.contentType}) - ${file.metadata.size} bytes`);
            });
        }
    } catch (error) {
        console.error('[ERROR] Failed to list files:', error);
    }

    // 2. Test Upload
    const testFileName = `verify_storage_test_${Date.now()}.txt`;
    const fileContent = 'This is a test file to verify Firebase Storage connectivity from SalePilot backend.';
    const remoteFilePath = `${folder}/${testFileName}`;
    const file = adminStorage.file(remoteFilePath);

    try {
        console.log(`\n--- Testing Upload: ${remoteFilePath} ---`);
        await file.save(fileContent, {
            metadata: { contentType: 'text/plain' },
            resumable: false
        });
        console.log('[SUCCESS] File uploaded successfully.');

        await file.makePublic();
        const publicUrl = `https://storage.googleapis.com/${adminStorage.name}/${remoteFilePath}`;
        console.log(`[INFO] Public URL: ${publicUrl}`);

    } catch (error) {
        console.error('[ERROR] Failed to upload file:', error);
        process.exit(1);
    }

    // 3. Test Delete
    try {
        console.log(`\n--- Testing Delete: ${remoteFilePath} ---`);
        await file.delete();
        console.log('[SUCCESS] File deleted successfully.');
    } catch (error) {
        console.error('[ERROR] Failed to delete file:', error);
    }

    console.log('\n--- Verification Complete ---');
}

verifyStorage().catch(console.error);
