import express from 'express';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';
import SocketService from '../services/socket.service';

const genId = (prefix: string) => `${prefix}_${Math.random().toString(36).substr(2, 9)}`;

// Find stores stocking what the request describes. Tokenized: "50 crates of
// sourdough bread" matches products containing ANY significant word, ranked
// by how many words each store's catalog hits — the whole-phrase match this
// replaced almost never fired on natural-language requests. Stores are
// returned best-match first, which is also the order sellers get notified in.
const findMatchingStores = async (query: string) => {
    const tokens = String(query || '')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3)
        .slice(0, 6);
    if (tokens.length === 0) return [];

    const params = tokens.map(t => `%${t}%`);
    const hit = (i: number) => `(name ILIKE $${i + 1} OR COALESCE(description,'') ILIKE $${i + 1} OR COALESCE(brand,'') ILIKE $${i + 1})`;
    const score = tokens.map((_, i) => `MAX(CASE WHEN ${hit(i)} THEN 1 ELSE 0 END)`).join(' + ');

    const result = await db.query(`
        SELECT store_id, (${score}) AS score
        FROM products
        WHERE status = 'active' AND store_id IS NOT NULL
          AND (${tokens.map((_, i) => hit(i)).join(' OR ')})
        GROUP BY store_id
        ORDER BY score DESC
        LIMIT 25
    `, params);
    return result.rows.map(r => r.store_id).filter(Boolean);
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

    const title = 'New Product Request';
    const message = `A customer "${request.customer_name}" is looking for "${request.query}" with a target price of ${request.target_price}.`;

    // Send Push Notification & Persist
    try {
        const { pushService } = await import('../services/push.service');
        await pushService.sendToStore(match.store_id, {
            title: 'New Product Request! 🔍',
            body: message,
            url: `/directory/request/${requestId}`
        });
    } catch (pushErr) {
        console.error('Failed to send push notification to seller:', pushErr);
    }

    const socketService = SocketService.getInstance();
    if (socketService) {
        socketService.broadcastToSellers('new_request', {
            requestId: requestId,
            title: title,
            description: request.query,
            targetPrice: request.target_price,
            storeId: match.store_id
        });
    }

    // Mark the match as notified — without this the supplier inbox
    // (getStorePendingMatches, status='notified') and submitOffer's match
    // update could never fire, and the same seller was re-notified forever.
    await db.query(
        `UPDATE marketplace_matches SET status = 'notified', updated_at = NOW() WHERE id = $1`,
        [match.id]
    );

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

        // Customer contact details are only for the request's owner (sellers get
        // them via the deal-confirmed notification after an offer is accepted).
        const row = { ...result.rows[0] };
        const isOwner = row.customer_id && req.user?.id === row.customer_id;
        if (!isOwner && req.user?.role !== 'superadmin') {
            row.customer_email = null;
            row.customer_phone = null;
        }

        res.status(200).json(toCamelCase({
            ...row,
            offers: offers.rows
        }));
    } catch (error) {
        console.error('Error fetching request details:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};

export const submitOffer = async (req: express.Request, res: express.Response) => {
    const { requestId, sellerPrice, productId } = req.body;
    if (!requestId || !(Number(sellerPrice) > 0)) {
        return res.status(400).json({ message: 'A request id and a positive price are required.' });
    }
    const offerId = genId('moff');
    // The offering store is the authenticated user's store — never trusted
    // from the body, so one store cannot submit offers in another's name.
    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

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
            const pushTitle = 'New Offer Received! 🎁';
            const pushBody = `A store has made an offer for your request: "${request.query}".`;
            // Send Push Notification & Persist
            try {
                const { pushService } = await import('../services/push.service');
                await pushService.sendToUsers([request.customer_id], {
                    title: pushTitle,
                    body: pushBody,
                    url: `/marketplace/track/${requestId}`
                });
            } catch (pushErr) {
                console.error('Failed to send push notification to customer:', pushErr);
            }
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

        // Only the customer who created the request (or a superadmin) may
        // accept/decline offers on it.
        const ownerRes = await db.query('SELECT customer_id FROM marketplace_requests WHERE id = $1', [offer.request_id]);
        const ownerId = ownerRes.rows[0]?.customer_id;
        if (ownerId && req.user?.id !== ownerId && req.user?.role !== 'superadmin') {
            return res.status(403).json({ message: 'You can only respond to offers on your own requests.' });
        }

        if (action === 'accept') {
            await db.query("UPDATE marketplace_offers SET status = 'accepted' WHERE id = $1", [offerId]);
            await db.query("UPDATE marketplace_requests SET status = 'completed' WHERE id = $1", [offer.request_id]);

            // Get store details for customer notification (if needed) but mainly for the Deal Confirmed UI
            const storeRes = await db.query('SELECT name, phone, email, address FROM store_settings WHERE store_id = $1', [offer.store_id]);
            const store = storeRes.rows[0];

            const requestRes = await db.query('SELECT customer_name, customer_phone, customer_email FROM marketplace_requests WHERE id = $1', [offer.request_id]);
            const request = requestRes.rows[0];

            // Notify seller with customer contact info
            const pushTitle = 'Deal Confirmed! 🎉';
            const pushBody = `Contact ${request.customer_name} at ${request.customer_phone || request.customer_email} to finalize the delivery.`;
            // Send Push Notification & Persist
            try {
                const { pushService } = await import('../services/push.service');
                await pushService.sendToStore(offer.store_id, {
                    title: pushTitle,
                    body: pushBody,
                    url: '/dashboard'
                });
            } catch (pushErr) {
                console.error('Failed to send push notification to seller for deal confirmation:', pushErr);
            }

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
    // A store may only read its own pending matches.
    const ownStoreId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (storeId !== ownStoreId && req.user?.role !== 'superadmin') {
        return res.status(403).json({ message: 'Forbidden' });
    }
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
        res.status(500).json({ message: 'Failed to fetch pending matches', error: (error as Error).message });
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

export const getMyOrders = async (req: express.Request, res: express.Response) => {
    const customerId = req.user!.id;
    try {
        // Fetch sales where the customer_id matches the logged-in user
        // We also join with sale_items to get product details (simplified JSON agg)
        // Match both legacy rows (customer_id = user id directly) and the
        // per-store customer records that link back via customers.user_id.
        const result = await db.query(`
            SELECT s.*,
                   ss.name as store_name,
                   ss.currency as store_currency,
                   COALESCE(json_agg(jsonb_build_object('name', p.name, 'quantity', si.quantity, 'price', si.price_at_sale, 'productId', si.product_id)) FILTER (WHERE si.id IS NOT NULL), '[]') as items
            FROM sales s
            JOIN store_settings ss ON s.store_id = ss.store_id
            LEFT JOIN customers c ON s.customer_id = c.id AND c.store_id = s.store_id
            LEFT JOIN sale_items si ON s.transaction_id = si.sale_id AND si.store_id = s.store_id
            LEFT JOIN products p ON si.product_id = p.id AND p.store_id = s.store_id
            WHERE s.customer_id = $1 OR c.user_id = $1
            GROUP BY s.transaction_id, ss.name, ss.currency
            ORDER BY s.timestamp DESC
        `, [customerId]);

        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching customer orders:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};
