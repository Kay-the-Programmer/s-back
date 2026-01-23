import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import db from '../db_client';
import { generateId } from '../utils/helpers';
import { VerificationDocument } from '../types';

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

        const result = await db.query(
            'SELECT is_verified, verification_documents FROM stores WHERE id = $1',
            [user.currentStoreId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Store not found' });
        }

        const { is_verified, verification_documents } = result.rows[0];
        // Postgres returns snake_case, we might need to map to camelCase if strictly followed, 
        // but the frontend likely expects what we send here. 
        // Let's send camelCase.
        return res.json({
            isVerified: is_verified,
            verificationDocuments: verification_documents || []
        });

    } catch (error) {
        console.error('Error getting verification status:', error);
        return res.status(500).json({ message: 'Error fetching status' });
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

        return res.json({ message: `Store verification status updated to ${status}` });
    } catch (error) {
        console.error('Error verifying store:', error);
        return res.status(500).json({ message: 'Error verifying store' });
    }
};
