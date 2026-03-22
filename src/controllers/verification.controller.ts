import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from '../db_client';
import { generateId } from '../utils/helpers';
import { VerificationDocument } from '../types';
import { invalidateUserCache } from '../middleware/auth.middleware';

// Configure storage
// Configure storage (Memory for cloud upload)
const storage = multer.memoryStorage();

const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    fileFilter: (req, file, cb) => {
        // Accept images and PDFs
        if (file.mimetype.startsWith('image/') || file.mimetype === 'application/pdf') {
            cb(null, true);
        } else {
            cb(new Error('Only images and PDF files are allowed'));
        }
    }
});

import { storageService } from '../services/storage.service';

export const uploadVerificationDocument = [
    upload.single('document'),
    async (req: express.Request, res: express.Response) => {
        try {
            const file = req.file;
            const user = req.user!;

            if (!user || !user.currentStoreId) {
                return res.status(401).json({ message: 'Unauthorized or no store selected' });
            }

            if (!file) {
                return res.status(400).json({ message: 'No file uploaded' });
            }

            // Upload to cloud storage
            // Use 'verification' folder
            const fileUrl = await storageService.uploadFile(file, 'verification');

            const docId = generateId('doc');
            const newDoc: VerificationDocument = {
                id: docId,
                name: file.originalname,
                url: fileUrl,
                uploadedAt: new Date().toISOString()
            };

            // Add to store's verificationDocuments array
            const storeId = user.currentStoreId;

            await db.query(`
        UPDATE stores 
        SET verification_documents = verification_documents || $1::jsonb
        WHERE id = $2
      `, [JSON.stringify(newDoc), storeId]);

            return res.status(201).json(newDoc);

        } catch (error) {
            console.error('Error uploading document:', error);
            return res.status(500).json({ message: 'Error uploading document' });
        }
    }
];

export const getVerificationStatus = async (req: express.Request, res: express.Response) => {
    try {
        const user = req.user!;
        if (!user || !user.currentStoreId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        // Fetch store-level business verification
        const storeResult = await db.query(
            'SELECT is_verified, verification_documents FROM stores WHERE id = $1',
            [user.currentStoreId]
        );

        if (storeResult.rowCount === 0) {
            return res.status(404).json({ message: 'Store not found' });
        }

        // Fetch user-level email/phone verification
        const userResult = await db.query(
            'SELECT is_verified AS email_verified, phone FROM users WHERE id = $1',
            [user.id]
        );

        const { is_verified, verification_documents } = storeResult.rows[0];
        const userRow = userResult.rows[0] || {};

        return res.json({
            isVerified: is_verified,
            verificationDocuments: verification_documents || [],
            isEmailVerified: userRow.email_verified ?? false,
            isPhoneVerified: !!userRow.phone,
            phoneNumber: userRow.phone || null,
        });

    } catch (error) {
        console.error('Error getting verification status:', error);
        return res.status(500).json({ message: 'Error fetching status' });
    }
};

// Verify phone number via Firebase ID Token
export const verifyPhone = async (req: express.Request, res: express.Response) => {
    try {
        const user = req.user!;
        if (!user) return res.status(401).json({ message: 'Unauthorized' });

        const { phoneIdToken, phoneNumber } = req.body;
        if (!phoneIdToken || !phoneNumber) {
            return res.status(400).json({ message: 'phoneIdToken and phoneNumber are required.' });
        }

        // Verify the Firebase ID token from phone auth
        const { adminApp } = await import('../firebase');
        if (adminApp) {
            try {
                const decoded = await adminApp.auth().verifyIdToken(phoneIdToken);
                if (!decoded.phone_number) {
                    return res.status(400).json({ message: 'No phone number in token.' });
                }
                // Optionally compare phoneNumber with decoded.phone_number for extra security
            } catch (authError) {
                console.error('[verifyPhone] Firebase token verification failed:', authError);
                return res.status(401).json({ message: 'Invalid phone authentication token.' });
            }
        } else {
            console.warn('[verifyPhone] Firebase Admin not available.');
            return res.status(503).json({ message: 'Authentication service unavailable.' });
        }

        // Save the verified phone number
        await db.query('UPDATE users SET phone = $1 WHERE id = $2', [phoneNumber, user.id]);
        
        invalidateUserCache(user.id);

        return res.json({ message: 'Phone verified and saved successfully.', phoneNumber });
    } catch (error) {
        console.error('Error verifying phone:', error);
        return res.status(500).json({ message: 'Failed to verify phone number.' });
    }
};

// Admin only
export const verifyStore = async (req: express.Request, res: express.Response) => {
    try {
        const { storeId, status } = req.body; // status: boolean
        const user = req.user!;

        // Check if user is admin/superadmin (simplified check)
        // In a real app, middleware handles this.
        // Assuming req.user.role is populated.
        if (user.role !== 'admin' && user.role !== 'superadmin') {
            return res.status(403).json({ message: 'Forbidden' });
        }

        await db.query('UPDATE stores SET is_verified = $1 WHERE id = $2', [status, storeId]);

        // --- Push Notification for Verification ---
        try {
            const { pushService } = await import('../services/push.service');
            await pushService.sendToStore(storeId, {
                title: status ? 'Store Verified! ✅' : 'Verification Revoked ⚠️',
                body: status
                    ? 'Your store account has been successfully verified by our team.'
                    : 'Your store verification status has been revoked. Please check your documents.',
                url: '/settings/verification'
            });
        } catch (pushErr) {
            console.error('Push failed for store verification update:', pushErr);
        }

        return res.json({ message: `Store verification status updated to ${status}` });
    } catch (error) {
        console.error('Error verifying store:', error);
        return res.status(500).json({ message: 'Error verifying store' });
    }
};
