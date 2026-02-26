import { Request, Response } from 'express';
import db from '../db_client';
import { generateId } from '../utils/helpers';
import SocketService from '../services/socket.service';
import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Configure Multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, '../../uploads/messages');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
export const upload = multer({ storage });


export const sendMessage = async (req: Request, res: Response) => {
    try {
        const { offerId, content } = req.body;
        const userId = (req as any).user.id;
        let imageUrl = null;

        if (req.file) {
            imageUrl = `/uploads/messages/${req.file.filename}`;
        }

        if (!offerId) {
            return res.status(400).json({ message: 'Offer ID is required' });
        }

        const id = generateId('msg');
        const query = `
            INSERT INTO offer_messages (id, offer_id, sender_id, content, image_url)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *
        `;
        const result = await db.query(query, [id, offerId, userId, content, imageUrl]);
        const message = result.rows[0];

        // Broadcast via socket
        const socketService = SocketService.getInstance();
        if (socketService) {
            socketService.emitToOffer(offerId, 'new_message', message);
        }

        // --- Push Notification ---
        try {
            const { pushService } = await import('../services/push.service');
            // Find participants
            const participantsRes = await db.query(`
                SELECT o.store_id, r.customer_id 
                FROM marketplace_offers o 
                JOIN marketplace_requests r ON o.request_id = r.id 
                WHERE o.id = $1
            `, [offerId]);

            if (participantsRes.rowCount && participantsRes.rowCount > 0) {
                const { store_id, customer_id } = participantsRes.rows[0];
                const isSenderCustomer = userId === customer_id;

                const senderRes = await db.query('SELECT name FROM users WHERE id = $1', [userId]);
                const senderName = senderRes.rows[0]?.name || 'Someone';

                if (isSenderCustomer) {
                    // Notify store staff
                    const userRes = await db.query('SELECT id FROM users WHERE current_store_id = $1', [store_id]);
                    const userIds = userRes.rows.map(u => u.id);
                    if (userIds.length > 0) {
                        await pushService.sendToUsers(userIds, {
                            title: `New Message from ${senderName}`,
                            body: content || 'Sent an image',
                            url: `/marketplace/offers/${offerId}`
                        });
                    }
                } else {
                    // Notify customer
                    if (customer_id) {
                        await pushService.sendToUsers([customer_id], {
                            title: `New Message from Store: ${senderName}`,
                            body: content || 'Sent an image',
                            url: `/marketplace/track/${offerId}` // might need correct tracking URL
                        });
                    }
                }
            }
        } catch (pushErr) {
            console.error('Push failed for internal message:', pushErr);
        }

        res.status(201).json(message);
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const getMessages = async (req: Request, res: Response) => {
    try {
        const { offerId } = req.params;
        const result = await db.query(`
            SELECT m.*, u.name as sender_name 
            FROM offer_messages m
            JOIN users u ON m.sender_id = u.id
            WHERE m.offer_id = $1
            ORDER BY m.created_at ASC
        `, [offerId]);

        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching messages:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
