import { Request, Response } from 'express';
import db from '../db_client';
import { generateId } from '../utils/helpers';
import SocketService from '../services/socket.service';

export const createOffer = async (req: Request, res: Response) => {
    try {
        const { title, description, latitude, longitude, store_id } = req.body;
        const userId = (req as any).user.id;

        if (!latitude || !longitude) {
            return res.status(400).json({ message: 'Location is required' });
        }

        const id = generateId('offer');
        const query = `
            INSERT INTO offers (id, user_id, title, description, latitude, longitude, store_id, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, 'open')
            RETURNING *
        `;
        const result = await db.query(query, [id, userId, title, description, latitude, longitude, store_id || null]);

        // Notify sellers
        const socketService = SocketService.getInstance();
        if (socketService) {
            socketService.broadcastToSellers('new_request', result.rows[0]);
        }

        res.status(201).json(result.rows[0]);
    } catch (error) {
        console.error('Error creating offer:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const getOffers = async (req: Request, res: Response) => {
    try {
        const result = await db.query(`
            SELECT o.*, u.name as user_name 
            FROM offers o 
            JOIN users u ON o.user_id = u.id 
            ORDER BY o.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error('Error fetching offers:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const getOfferById = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const result = await db.query(`
            SELECT o.*, u.name as user_name,
            au.name as accepted_by_name
            FROM offers o
            JOIN users u ON o.user_id = u.id
            LEFT JOIN users au ON o.accepted_by = au.id
            WHERE o.id = $1
        `, [id]);

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Offer not found' });
        }
        res.json(result.rows[0]);
    } catch (error) {
        console.error('Error fetching offer:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const acceptOffer = async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const userId = (req as any).user.id; // Seller

        const checkFn = await db.query('SELECT status, user_id FROM offers WHERE id = $1', [id]);
        if (checkFn.rowCount === 0) {
            return res.status(404).json({ message: 'Offer not found' });
        }
        const offer = checkFn.rows[0];

        if (offer.status !== 'open') {
            return res.status(400).json({ message: 'Offer is not open' });
        }
        if (offer.user_id === userId) {
            return res.status(400).json({ message: 'Cannot accept your own offer' });
        }

        const result = await db.query(`
            UPDATE offers 
            SET status = 'accepted', accepted_by = $1 
            WHERE id = $2 
            RETURNING *
        `, [userId, id]);

        const updatedOffer = result.rows[0];

        // Notify customer via socket
        const socketService = SocketService.getInstance();
        if (socketService) {
            socketService.emitToOffer(id, 'offer_accepted', { offerId: id, acceptedBy: userId });
        }

        res.json(updatedOffer);
    } catch (error) {
        console.error('Error accepting offer:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
