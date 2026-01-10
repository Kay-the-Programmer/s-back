import express from 'express';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';

const genId = (prefix: string) => `${prefix}_${Math.random().toString(36).substr(2, 9)}`;

// Helper to find stores that have products matching the query
const findMatchingStores = async (query: string) => {
    const searchPattern = `%${query}%`;
    const result = await db.query(`
        SELECT DISTINCT store_id 
        FROM products 
        WHERE (LOWER(name) LIKE LOWER($1) OR LOWER(description) LIKE LOWER($1))
        AND status = 'active'
    `, [searchPattern]);
    return result.rows.map(r => r.store_id);
};

export const getRecentRequests = async (req: express.Request, res: express.Response) => {
    try {
        const result = await db.query(`
            SELECT id, query, target_price, created_at, customer_name
            FROM marketplace_requests 
            WHERE status IN ('open', 'matched')
            ORDER BY created_at DESC 
            LIMIT 10
        `);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching recent requests:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

const notifyNextSeller = async (requestId: string) => {
    // Find the next pending match
    const matchRes = await db.query(`
        SELECT * FROM marketplace_matches 
        WHERE request_id = $1 AND status = 'pending'
        ORDER BY created_at ASC 
        LIMIT 1
    `, [requestId]);

    if (matchRes.rowCount === 0) {
        return false;
    }

    const match = matchRes.rows[0];
    const requestRes = await db.query('SELECT * FROM marketplace_requests WHERE id = $1', [requestId]);
    const request = requestRes.rows[0];

    // Notification for the store
    await db.query(`
        INSERT INTO notifications (id, store_id, title, message, type, link)
        VALUES ($1, $2, $3, $4, $5, $6)
    `, [
        genId('notif'),
        match.store_id,
        'New Product Request',
        `A customer "${request.customer_name}" is looking for "${request.query}" with a target price of ${request.target_price}.`,
        'marketplace',
        `/directory/request/${requestId}`
    ]);

    // Update match status to notified
    await db.query(`UPDATE marketplace_matches SET status = 'notified', updated_at = NOW() WHERE id = $1`, [match.id]);

    return true;
};

export const createMarketplaceRequest = async (req: express.Request, res: express.Response) => {
    const { customerName, customerEmail, customerPhone, query, targetPrice } = req.body;
    const requestId = genId('mreq');
    const customerId = req.user?.id;

    try {
        await db.query(`
            INSERT INTO marketplace_requests (id, customer_id, customer_name, customer_email, customer_phone, query, target_price)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [requestId, customerId || null, customerName, customerEmail, customerPhone, query, targetPrice || 0]);

        // If the user is logged in but doesn't have a phone number, update it
        if (customerId && customerPhone) {
            await db.query(`
                UPDATE users SET phone = COALESCE(phone, $1) WHERE id = $2
            `, [customerPhone, customerId]);
        }

        const storeIds = await findMatchingStores(query);

        if (storeIds.length > 0) {
            for (const storeId of storeIds) {
                await db.query(`
                    INSERT INTO marketplace_matches (id, request_id, store_id)
                    VALUES ($1, $2, $3)
                `, [genId('match'), requestId, storeId]);
            }

            // Notify the first seller
            await notifyNextSeller(requestId);
        } else {
            // Optional: Handle case where no stores match initially
            // We might still keep it open for future matches, or notify customer
        }

        res.status(201).json({ id: requestId, message: 'Request created. Matching in progress.' });
    } catch (error) {
        console.error('Error creating marketplace request:', error);
        res.status(500).json({ message: 'Failed to create request' });
    }
};

export const getRequestDetails = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const result = await db.query('SELECT * FROM marketplace_requests WHERE id = $1', [id]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'Request not found' });

        const offers = await db.query(`
            SELECT o.*, ss.name as store_name, ss.phone as store_phone, ss.email as store_email, ss.address as store_address
            FROM marketplace_offers o
            JOIN store_settings ss ON o.store_id = ss.store_id
            WHERE o.request_id = $1
        `, [id]);

        res.status(200).json(toCamelCase({
            ...result.rows[0],
            offers: offers.rows
        }));
    } catch (error) {
        console.error('Error fetching request details:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const submitOffer = async (req: express.Request, res: express.Response) => {
    const { requestId, storeId, sellerPrice, productId } = req.body;
    const offerId = genId('moff');

    try {
        // Update the match status
        await db.query(`
            UPDATE marketplace_matches 
            SET status = 'offered', updated_at = NOW() 
            WHERE request_id = $1 AND store_id = $2 AND status = 'notified'
        `, [requestId, storeId]);

        await db.query(`
            INSERT INTO marketplace_offers (id, request_id, store_id, product_id, seller_price)
            VALUES ($1, $2, $3, $4, $5)
        `, [offerId, requestId, storeId, productId || null, sellerPrice]);

        // Notify the customer if they are a registered user
        const requestRes = await db.query('SELECT customer_id, query FROM marketplace_requests WHERE id = $1', [requestId]);
        const request = requestRes.rows[0];
        if (request && request.customer_id) {
            await db.query(`
                INSERT INTO notifications (id, user_id, title, message, type, link)
                VALUES ($1, $2, $3, $4, $5, $6)
            `, [
                genId('notif'),
                request.customer_id,
                'New Offer Received! 🎁',
                `A store has made an offer for your request: "${request.query}".`,
                'marketplace',
                `/marketplace/track/${requestId}`
            ]);
        }

        res.status(201).json({ id: offerId, message: 'Offer submitted successfully' });
    } catch (error) {
        console.error('Error submitting offer:', error);
        res.status(500).json({ message: 'Failed to submit offer' });
    }
};

export const respondToOffer = async (req: express.Request, res: express.Response) => {
    const { offerId } = req.params;
    const { action } = req.body; // 'accept' or 'decline'

    try {
        const offerRes = await db.query('SELECT * FROM marketplace_offers WHERE id = $1', [offerId]);
        if (offerRes.rowCount === 0) return res.status(404).json({ message: 'Offer not found' });
        const offer = offerRes.rows[0];

        if (action === 'accept') {
            await db.query("UPDATE marketplace_offers SET status = 'accepted' WHERE id = $1", [offerId]);
            await db.query("UPDATE marketplace_requests SET status = 'completed' WHERE id = $1", [offer.request_id]);

            // Get store details for customer notification (if needed) but mainly for the Deal Confirmed UI
            const storeRes = await db.query('SELECT name, phone, email, address FROM store_settings WHERE store_id = $1', [offer.store_id]);
            const store = storeRes.rows[0];

            const requestRes = await db.query('SELECT customer_name, customer_phone, customer_email FROM marketplace_requests WHERE id = $1', [offer.request_id]);
            const request = requestRes.rows[0];

            // Notify seller with customer contact info
            await db.query(`
                INSERT INTO notifications (id, store_id, title, message, type)
                VALUES ($1, $2, $3, $4, $5)
            `, [
                genId('notif'),
                offer.store_id,
                'Deal Confirmed! 🎉',
                `Contact ${request.customer_name} at ${request.customer_phone || request.customer_email} to finalize the delivery of "${offer.query}".`,
                'marketplace'
            ]);

        } else if (action === 'decline') {
            await db.query("UPDATE marketplace_offers SET status = 'declined' WHERE id = $1", [offerId]);

            // App makes another match
            const hasMore = await notifyNextSeller(offer.request_id);
            if (!hasMore) {
                // If no more sellers, either keep open or mark as no matches found
                await db.query("UPDATE marketplace_requests SET status = 'open' WHERE id = $1", [offer.request_id]);
            }
        }

        res.status(200).json({ message: `Offer ${action}ed` });
    } catch (error) {
        console.error('Error responding to offer:', error);
        res.status(500).json({ message: 'Failed to respond to offer' });
    }
};

export const getStorePendingMatches = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    try {
        const result = await db.query(`
            SELECT m.*, r.query, r.target_price, r.customer_name, r.created_at as request_created_at
            FROM marketplace_matches m
            JOIN marketplace_requests r ON m.request_id = r.id
            WHERE m.store_id = $1 AND m.status = 'notified'
            ORDER BY m.updated_at DESC
        `, [storeId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching pending matches:', error);
        res.status(500).json({ message: 'Failed to fetch pending matches' });
    }
};
export const getCustomerRequests = async (req: express.Request, res: express.Response) => {
    const customerId = req.user!.id;
    try {
        const result = await db.query(`
            SELECT r.*, 
                   (SELECT COUNT(*) FROM marketplace_offers WHERE request_id = r.id) as offer_count
            FROM marketplace_requests r
            WHERE r.customer_id = $1
            ORDER BY r.created_at DESC
        `, [customerId]);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching customer requests:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
