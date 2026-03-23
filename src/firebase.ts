// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getStorage } from "firebase/storage";
import admin from 'firebase-admin';
import dotenv from 'dotenv';
dotenv.config();

// --- Client SDK Configuration (Existing) ---
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY || "AIzaSyBqcS-rap5P5jRl7nhfdESKWEJtZb4Zy8c",
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || "salepilot-ae09f.firebaseapp.com",
    projectId: process.env.FIREBASE_PROJECT_ID || "salepilot-ae09f",
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "salepilot-ae09f.appspot.com",
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID || "980903093215",
    appId: process.env.FIREBASE_APP_ID || "1:980903093215:web:2c821c0758a9ec70335a6a",
    measurementId: process.env.FIREBASE_MEASUREMENT_ID || "G-2885SSEE1Y"
};

// Initialize Client SDK
const app = initializeApp(firebaseConfig);
export const authentication = getAuth(app);
export const storage = getStorage(app); // Client SDK Storage

// --- Admin SDK Configuration (New) ---
let adminApp: admin.app.App | null = null;
let bucket: any = null;
let adminDb: admin.firestore.Firestore | null = null;

try {
    const serviceAccountVar = process.env.FIREBASE_SERVICE_ACCOUNT;

    if (serviceAccountVar) {
        let serviceAccount;
        if (serviceAccountVar.startsWith('{')) {
            serviceAccount = JSON.parse(serviceAccountVar);
        } else {
            // Assume file path if not JSON string
            // serviceAccount = require(path.resolve(serviceAccountVar));
            console.warn('FIREBASE_SERVICE_ACCOUNT should be a JSON string content.');
        }

        if (serviceAccount) {
            adminApp = admin.initializeApp({
                credential: admin.credential.cert(serviceAccount),
                storageBucket: firebaseConfig.storageBucket
            });

            bucket = adminApp.storage().bucket();

            // Support custom Database ID if provided, otherwise default to '(default)'
            const databaseId = process.env.FIREBASE_DATABASE_ID || '(default)';
            adminDb = adminApp.firestore();

            console.log(`Firebase Admin SDK initialized successfully for project: ${serviceAccount.project_id}, database: ${databaseId}`);
        }
    } else {
        console.warn('FIREBASE_SERVICE_ACCOUNT env var not found. Using Client SDK fallback for storage (less reliable for backend).');
    }
} catch (error) {
    console.error('Error initializing Firebase Admin SDK:', error);
}

export const adminStorage = bucket;
export { adminDb, adminApp };
