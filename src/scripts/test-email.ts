import admin from 'firebase-admin';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountVar) {
    console.error('FIREBASE_SERVICE_ACCOUNT not found in .env');
    process.exit(1);
}

async function runTest() {
    try {
        let serviceAccount;
        if (serviceAccountVar!.startsWith('{')) {
            serviceAccount = JSON.parse(serviceAccountVar!);
            console.log('Successfully parsed service account JSON.');
        } else {
            console.error('FIREBASE_SERVICE_ACCOUNT should be a JSON string content.');
            process.exit(1);
        }

        const adminApp = admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        const adminDb = adminApp.firestore();
        console.log('Firebase Admin SDK initialized successfully.');
        console.log('Project ID from adminApp:', (adminApp.options as any).projectId || serviceAccount.project_id);
        console.log('Database ID:', (adminDb as any)._databaseId || 'default');
        console.log('Settings:', (adminDb as any)._settings);

        const testEmail = 'test@example.com';
        const otp = '123456';

        console.log(`Attempting to list collections...`);
        const collections = await adminDb.listCollections();
        console.log('Collections found:', collections.map(c => c.id));

        console.log(`Attempting to write test email to 'mail' collection for ${testEmail}...`);

        const docRef = await adminDb.collection('mail').add({
            to: testEmail,
            message: {
                subject: 'Test Verification Email',
                text: `Your test verification code is: ${otp}`,
                html: `<p>Your test verification code is: <b>${otp}</b></p>`,
            },
        });
        console.log('Document successfully added to Firestore with ID:', docRef.id);
        process.exit(0);

    } catch (error) {
        console.error('Error during initialization or test:', error);
        process.exit(1);
    }
}

runTest();
