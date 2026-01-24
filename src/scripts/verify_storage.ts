
import { adminStorage } from '../firebase';

async function verifyStorage() {
    console.log('--- Starting Firebase Storage Bucket Check ---');

    if (!adminStorage) {
        console.error('[ERROR] adminStorage is not initialized. Check your .env credentials.');
        process.exit(1);
    }

    // Try just the project ID as bucket name
    const projectBucketName = 'salepilot-ae09f';
    console.log(`[INFO] Testing access to specific bucket: ${projectBucketName}`);

    try {
        const bucket = adminStorage.storage.bucket(projectBucketName);
        const [exists] = await bucket.exists();

        if (exists) {
            console.log(`[SUCCESS] Bucket '${projectBucketName}' exists!`);
            // ... list files ...
            const [files] = await bucket.getFiles({ maxResults: 5, prefix: 'products/' });
            console.log(`[SUCCESS] Successfully listed ${files.length} files in 'products/'.`);
            files.forEach((f: any) => console.log(`- ${f.name}`));

            console.log('\n[CONCLUSION] please update .env FIREBASE_STORAGE_BUCKET to ' + projectBucketName);
        } else {
            console.log(`[ERROR] Bucket '${projectBucketName}' does not exist.`);
        }
    } catch (error) {
        console.log(`[ERROR] Failed to access bucket '${projectBucketName}':`);
        console.error(error);
    }

    console.log('\n--- Check Complete ---');
}

verifyStorage().catch(console.error);
