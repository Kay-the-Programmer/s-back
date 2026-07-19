import express from 'express';
import db from '../db_client';
import { toCamelCase, generateId } from '../utils/helpers';
import { accountingService } from '../services/accounting.service';
import SocketService from '../services/socket.service';
import { sendTemplatedEmail } from '../services/email-template.service';
import { pushService } from '../services/push.service';

// Whitelisted sort options → SQL. Never interpolate the raw query param.
const PRODUCT_SORTS: Record<string, string> = {
    name: 'name ASC',
    price_asc: 'price ASC',
    price_desc: 'price DESC',
    newest: 'created_at DESC NULLS LAST, name ASC',
};

const parsePageParams = (req: express.Request, defaultLimit = 24, maxLimit = 60) => {
    // Envelope pagination only kicks in when the caller explicitly sends
    // `page` — otherwise legacy consumers keep getting a plain array.
    const rawPage = parseInt(String(req.query.page ?? ''), 10);
    const paginated = Number.isFinite(rawPage) && rawPage > 0;
    const page = paginated ? rawPage : 1;
    const limit = Math.min(maxLimit, Math.max(1, parseInt(String(req.query.limit || ''), 10) || defaultLimit));
    return { page, limit, paginated };
};

// Helper to filter product fields for public display
const sanitizeProduct = (product: any) => {
    return {
        id: product.id,
        name: product.name,
        description: product.description,
        sku: product.sku,
        price: parseFloat(product.price),
        stock: parseFloat(product.stock),
        category_id: product.category_id,
        image_urls: product.image_urls,
        brand: product.brand,
        status: product.status,
        unit_of_measure: product.unit_of_measure,
        weight: parseFloat(product.weight || 0),
        dimensions: product.dimensions,
        variants: product.variants,
        custom_attributes: product.custom_attributes,
        store_id: product.store_id
    };
};

export const getShopInfo = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    try {
        const storeResult = await db.query(
            'SELECT id, name, status, created_at FROM stores WHERE id = $1',
            [storeId]
        );

        if (storeResult.rowCount === 0) {
            return res.status(404).json({ message: 'Store not found' });
        }

        const store = storeResult.rows[0];

        // Also fetch public store settings (currency, contact info, etc.)
        const settingsResult = await db.query(
            'SELECT name, address, phone, email, website, currency, tax_rate, delivery_fee, is_online_store_enabled, is_wholesale_supplier, receipt_message FROM store_settings WHERE store_id = $1',
            [storeId]
        );

        const settings = (settingsResult.rowCount || 0) > 0 ? settingsResult.rows[0] : {};

        res.status(200).json(toCamelCase({
            ...store,
            settings: settings
        }));
    } catch (error) {
        console.error(`Error fetching shop info for ${storeId}:`, error);
        res.status(500).json({ message: 'Error fetching shop info' });
    }
};

export const getShopProducts = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    const { categoryId, search } = req.query;
    const { page, limit, paginated } = parsePageParams(req);
    const orderBy = PRODUCT_SORTS[String(req.query.sort || '')] || PRODUCT_SORTS.name;

    try {
        let whereClause = `WHERE store_id = $1 AND status = 'active'`;
        const params: any[] = [storeId];

        if (categoryId) {
            params.push(categoryId);
            whereClause += ` AND category_id = $${params.length}`;
        }

        // Availability facet: ?inStock=1 hides sold-out items.
        if (String(req.query.inStock || '') === '1') {
            whereClause += ` AND stock > 0`;
        }

        if (search) {
            params.push(`%${search}%`);
            whereClause += ` AND (LOWER(name) LIKE LOWER($${params.length}) OR LOWER(description) LIKE LOWER($${params.length}) OR LOWER(COALESCE(brand,'')) LIKE LOWER($${params.length}) OR LOWER(COALESCE(sku,'')) LIKE LOWER($${params.length}))`;
        }

        let queryText = `SELECT * FROM products ${whereClause} ORDER BY ${orderBy}`;

        if (paginated) {
            // Envelope response: { items, total, page, pageSize }
            const countRes = await db.query(`SELECT COUNT(*)::int AS total FROM products ${whereClause}`, params);
            const total = countRes.rows[0]?.total ?? 0;
            const pageParams = [...params, limit, (page - 1) * limit];
            queryText += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
            const result = await db.query(queryText, pageParams);
            return res.status(200).json({
                items: toCamelCase(result.rows.map(sanitizeProduct)),
                total,
                page,
                pageSize: limit,
            });
        }

        // Legacy contract: plain array when no `page` param is sent.
        const result = await db.query(queryText, params);
        const sanitizedProducts = result.rows.map(sanitizeProduct);
        res.status(200).json(toCamelCase(sanitizedProducts));
    } catch (error) {
        console.error(`Error fetching products for shop ${storeId}:`, error);
        res.status(500).json({ message: 'Error fetching products' });
    }
};

export const getShopProductById = async (req: express.Request, res: express.Response) => {
    const { storeId, productId } = req.params;
    try {
        const result = await db.query(
            'SELECT * FROM products WHERE id = $1 AND store_id = $2 AND status = \'active\'',
            [productId, storeId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }

        res.status(200).json(toCamelCase(sanitizeProduct(result.rows[0])));
    } catch (error) {
        console.error(`Error fetching product ${productId} for shop ${storeId}:`, error);
        res.status(500).json({ message: 'Error fetching product' });
    }
};

export const getShopCategories = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    try {
        // Only categories that actually contain live products — a storefront
        // filter with zero results is noise. product_count powers "(N)" badges.
        const result = await db.query(
            `SELECT c.id, c.name, c.parent_id, COUNT(p.id)::int AS product_count
             FROM categories c
             JOIN products p ON p.category_id = c.id AND p.store_id = c.store_id AND p.status = 'active'
             WHERE c.store_id = $1
             GROUP BY c.id, c.name, c.parent_id
             ORDER BY c.name ASC`,
            [storeId]
        );
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error(`Error fetching categories for shop ${storeId}:`, error);
        res.status(500).json({ message: 'Error fetching categories' });
    }
}

export const createShopOrder = async (req: express.Request, res: express.Response) => {
    const { storeId } = req.params;
    const { cart } = req.body;
    let { customerDetails } = req.body;

    if (!cart || !Array.isArray(cart) || cart.length === 0) {
        return res.status(400).json({ message: 'Cart cannot be empty' });
    }
    if (cart.length > 100) {
        return res.status(400).json({ message: 'Too many items in cart.' });
    }

    if (!customerDetails || !String(customerDetails.name || '').trim()) {
        return res.status(400).json({ message: 'Customer details (name) required' });
    }

    // Sanitize free-text customer fields: trim + length-cap. These are stored and
    // later rendered in the store dashboard, so keep them bounded.
    const capStr = (v: any, max: number) => String(v ?? '').trim().slice(0, max) || null;
    // Fulfillment method drives the delivery fee; legacy clients that don't
    // send it are treated as fee-free (fee only ever applies to 'delivery').
    const fulfillment = req.body.fulfillment === 'pickup' ? 'pickup'
        : req.body.fulfillment === 'delivery' ? 'delivery' : null;
    customerDetails = {
        name: capStr(customerDetails.name, 120),
        email: capStr(customerDetails.email, 254)?.toLowerCase() || null,
        phone: capStr(customerDetails.phone, 32),
        address: capStr(customerDetails.address, 500),
        note: capStr(customerDetails.note, 500),
        ...(fulfillment ? { fulfillment } : {}),
    };
    if (customerDetails.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customerDetails.email)) {
        return res.status(400).json({ message: 'Invalid email address.' });
    }

    const client = await db._pool.connect();

    try {
        await client.query('BEGIN');

        // 0. The store must exist, be active, and have its online store enabled —
        // otherwise a disabled shop could still accept orders via direct API calls.
        const storeRes = await client.query(
            `SELECT s.id FROM stores s
             LEFT JOIN store_settings ss ON s.id = ss.store_id
             WHERE s.id = $1 AND s.status = 'active'
               AND (ss.is_online_store_enabled IS NULL OR ss.is_online_store_enabled = TRUE)`,
            [storeId]
        );
        if (storeRes.rowCount === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: 'Store not found or not accepting online orders.' });
        }

        // 1. Handle Customer (Find or Create)
        let customerId = null;
        // SECURITY: identity comes ONLY from the verified session (optionalProtect),
        // never from the request body — a guest could otherwise attach orders to
        // (and create customer records under) any user's id.
        const userId = (req as any).user?.id || null;

        if (userId) {
            // Authenticated buyer: find this store's customer record for the
            // account. customers.id is a GLOBAL PK, so re-using the user id as
            // the customer id only works for ONE store — a buyer ordering from
            // a second store collided on the PK and the whole checkout rolled
            // back. Per-store records now get their own ids and link back to
            // the account via customers.user_id (legacy rows kept id=userId,
            // hence the OR).
            const customerRes = await client.query(
                'SELECT id FROM customers WHERE (user_id = $1 OR id = $1) AND store_id = $2',
                [userId, storeId]
            );

            if ((customerRes.rowCount || 0) > 0) {
                customerId = customerRes.rows[0].id;
            } else {
                customerId = generateId('cus');
                await client.query(
                    'INSERT INTO customers (id, user_id, name, email, phone, address, store_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())',
                    [
                        customerId,
                        userId,
                        customerDetails.name,
                        customerDetails.email,
                        customerDetails.phone,
                        JSON.stringify({ street: customerDetails.address }),
                        storeId
                    ]
                );
            }
        } else if (customerDetails.email) {
            // Guest with Email
            const customerRes = await client.query(
                'SELECT id FROM customers WHERE email = $1 AND store_id = $2',
                [customerDetails.email, storeId]
            );
            if ((customerRes.rowCount || 0) > 0) {
                customerId = customerRes.rows[0].id;
            } else {
                customerId = generateId('cus');
                await client.query(
                    'INSERT INTO customers (id, name, email, phone, address, store_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
                    [
                        customerId,
                        customerDetails.name,
                        customerDetails.email,
                        customerDetails.phone,
                        JSON.stringify({ street: customerDetails.address }), // Simple mapping for now
                        storeId
                    ]
                );
            }
        } else {
            // Guest without email
            customerId = generateId('cus');
            await client.query(
                'INSERT INTO customers (id, name, email, phone, address, store_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, NOW())',
                [
                    customerId,
                    customerDetails.name,
                    customerDetails.email || null,
                    customerDetails.phone || null,
                    JSON.stringify({ street: customerDetails.address }),
                    storeId
                ]
            );
        }

        // 2. Calculate Totals (Server-side validation) to ensure integrity
        let subtotal = 0;
        const validItems = [];

        for (const item of cart) {
            const productId = item.productId || item.id;
            if (!productId) {
                console.warn('Skipping cart item with no ID:', item);
                continue;
            }

            // Validate quantity (bounded to keep math + storage sane)
            const quantity = parseFloat(item.quantity);
            if (isNaN(quantity) || quantity <= 0 || quantity > 9999) {
                console.warn(`Invalid quantity for product ${productId}:`, item.quantity);
                continue;
            }

            // FOR UPDATE: lock the row so two concurrent checkouts can't both
            // pass the stock check and oversell the same units.
            const prodRes = await client.query(
                'SELECT id, price, cost_price, name, stock FROM products WHERE id = $1 AND store_id = $2 AND status = \'active\' FOR UPDATE',
                [productId, storeId]
            );

            if (prodRes.rowCount === 0) {
                console.warn(`Product not found during checkout: ${productId} for store ${storeId}`);
                continue;
            }
            const product = prodRes.rows[0];

            // Stock validation: never let an online order drive stock negative.
            const available = parseFloat(product.stock);
            if (!isNaN(available) && available < quantity) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: available > 0
                        ? `Only ${available} of "${product.name}" left in stock. Please adjust your cart.`
                        : `"${product.name}" is out of stock. Please remove it from your cart.`,
                    code: 'INSUFFICIENT_STOCK',
                    productId,
                    available,
                });
            }

            const price = parseFloat(product.price);
            if (isNaN(price)) {
                console.error(`Invalid price for product ${productId}:`, product.price);
                continue;
            }

            const lineTotal = price * quantity;
            subtotal += lineTotal;

            validItems.push({
                ...item,
                productId: productId,
                id: productId,
                quantity: quantity, // Use parsed quantity
                costPrice: parseFloat(product.cost_price || 0),
                price: price
            });
        }

        if (validItems.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: 'No valid items in cart to checkout.' });
        }

        // Tax at the store's configured rate (was a hardcoded 10% placeholder).
        const settingsRes = await client.query('SELECT tax_rate, delivery_fee FROM store_settings WHERE store_id = $1', [storeId]);
        const taxRatePct = settingsRes.rowCount ? Number(settingsRes.rows[0].tax_rate) || 0 : 0;
        const round2 = (n: number) => Math.round(n * 100) / 100;
        subtotal = round2(subtotal);
        const tax = round2(subtotal * (taxRatePct / 100));
        // Flat store-configured delivery fee, charged only on delivery orders.
        const deliveryFee = fulfillment === 'delivery'
            ? round2(Math.max(0, settingsRes.rowCount ? Number(settingsRes.rows[0].delivery_fee) || 0 : 0))
            : 0;
        const total = round2(subtotal + tax + deliveryFee);
        const transactionId = generateId('ord');
        const timestamp = new Date().toISOString();

        // 3. Create Sale Record
        await client.query(
            `INSERT INTO sales (
                transaction_id, "timestamp", customer_id, total, subtotal, tax, discount,
                payment_status, fulfillment_status, channel, customer_details,
                amount_paid, refund_status, store_id, delivery_fee
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
            [
                transactionId, timestamp, customerId, total, subtotal, tax, 0,
                'unpaid', 'pending', 'online', JSON.stringify(customerDetails),
                0, 'none', storeId, deliveryFee
            ]
        );

        // 4. Insert Items and Update Stock
        for (const item of validItems) {
            await client.query(
                'INSERT INTO sale_items (sale_id, product_id, quantity, price_at_sale, cost_at_sale, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
                [transactionId, item.productId, item.quantity, item.price, item.costPrice, storeId]
            );

            // Deduct stock (Reservation)
            await client.query(
                'UPDATE products SET stock = stock - $1 WHERE id = $2 AND store_id = $3',
                [item.quantity, item.productId, storeId]
            );
        }

        // 5. Record in Accounting
        const saleForAccounting = {
            transactionId,
            timestamp,
            customerId,
            total,
            subtotal,
            tax,
            deliveryFee,
            discount: 0,
            paymentStatus: 'unpaid',
            amountPaid: 0,
            cart: validItems,
            customerName: customerDetails.name
        };

        await accountingService.recordSale(saleForAccounting as any, client, storeId);

        await client.query('COMMIT');

        const orderResponse = {
            message: 'Order placed successfully',
            orderId: transactionId,
            total,
            subtotal,
            tax,
            deliveryFee,
            status: 'pending',
            timestamp,
            customerId,
            customerName: customerDetails.name,
            channel: 'online'
        };

        // Broadcast to store room for real-time updates in the dashboard
        try {
            SocketService.getInstance().emitToStore(storeId, 'new_order', {
                ...orderResponse,
                transactionId,
                paymentStatus: 'unpaid',
                fulfillmentStatus: 'pending',
                cart: validItems,
                customerDetails
            });
        } catch (socketError) {
            console.error('Failed to broadcast new shop order via socket:', socketError);
        }

        // Durable owner notification + web push (mirrors the POS createSale
        // pattern) — the socket event above is lost unless a dashboard is open.
        try {
            await pushService.sendToStore(storeId, {
                title: 'New online order 🛍️',
                body: `Order ${transactionId} — ${customerDetails.name} — ${total.toFixed(2)} (${fulfillment || 'delivery/pickup'})`,
                url: '/pos/history',
            }, ['admin', 'staff', 'superadmin']);
        } catch (pushError) {
            console.error('Failed to send push notification for shop order:', pushError);
        }

        // Order confirmation email to the buyer (configurable engine template).
        if (customerDetails.email) {
            try {
                const nameRes = await db.query('SELECT name, currency FROM store_settings WHERE store_id = $1', [storeId]);
                await sendTemplatedEmail('ORDER_CONFIRMATION', customerDetails.email, {
                    storeName: nameRes.rows[0]?.name || 'the store',
                    currency: nameRes.rows[0]?.currency?.symbol || 'K',
                    userName: customerDetails.name || 'Customer',
                    transactionId,
                    total,
                });
            } catch (emailError) {
                console.error('Failed to send shop order confirmation email:', emailError);
            }
        }

        res.status(201).json(orderResponse);

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating shop order:', error);
        res.status(500).json({
            message: 'Failed to place order',
            error: error instanceof Error ? error.message : String(error),
            details: error
        });
    } finally {
        client.release();
    }
};

export const getPublicStores = async (req: express.Request, res: express.Response) => {
    try {
        // ?wholesale=1 → only stores that opted into the B2B wholesale
        // marketplace (the /marketplace supplier directory uses this).
        const wholesaleOnly = String(req.query.wholesale || '') === '1';
        const result = await db.query(`
            SELECT s.id, s.name, s.status, ss.address, ss.phone, ss.email, ss.website,
            COALESCE(ss.is_wholesale_supplier, FALSE) as is_wholesale_supplier,
            COALESCE(ss.currency, '{"code":"USD","symbol":"$","position":"before"}') as currency
            FROM stores s
            LEFT JOIN store_settings ss ON s.id = ss.store_id
            WHERE s.status = 'active' AND (ss.is_online_store_enabled IS NULL OR ss.is_online_store_enabled = TRUE)
            ${wholesaleOnly ? 'AND ss.is_wholesale_supplier = TRUE' : ''}
        `);

        // Helper to parse currency safely
        const parseCurrency = (row: any) => {
            try {
                return typeof row.currency === 'string' ? JSON.parse(row.currency) : row.currency;
            } catch (e) {
                return { code: 'USD', symbol: '$', position: 'before' };
            }
        };

        const sanitizedStores = result.rows.map(s => ({
            ...s,
            currency: parseCurrency(s)
        }));

        res.status(200).json(toCamelCase(sanitizedStores));
    } catch (error) {
        console.error('Error fetching public stores:', error);
        res.status(500).json({ message: 'Failed to fetch stores' });
    }
};

export const getGlobalProducts = async (req: express.Request, res: express.Response) => {
    const { search } = req.query;
    const { page, limit, paginated } = parsePageParams(req);
    const sortKey = String(req.query.sort || '');
    const orderBy = PRODUCT_SORTS[sortKey]
        ? PRODUCT_SORTS[sortKey].replace(/^(name|price|created_at)/g, 'p.$1')
        : 'p.name ASC';

    try {
        let whereClause = `
            WHERE p.status = 'active'
            AND s.status = 'active'
            AND (ss.is_online_store_enabled IS NULL OR ss.is_online_store_enabled = TRUE)
        `;
        // ?wholesale=1 → only products from opted-in wholesale suppliers.
        if (String(req.query.wholesale || '') === '1') {
            whereClause += ` AND ss.is_wholesale_supplier = TRUE`;
        }
        const params: any[] = [];

        if (search) {
            params.push(`%${search}%`);
            whereClause += ` AND (LOWER(p.name) LIKE LOWER($${params.length}) OR LOWER(COALESCE(p.description,'')) LIKE LOWER($${params.length}) OR LOWER(COALESCE(p.brand,'')) LIKE LOWER($${params.length}) OR LOWER(s.name) LIKE LOWER($${params.length}))`;
        }

        const baseQuery = `
            SELECT p.*, s.name as store_name,
            COALESCE(ss.currency, '{"code":"USD","symbol":"$","position":"before"}') as store_currency
            FROM products p
            JOIN stores s ON p.store_id = s.id
            LEFT JOIN store_settings ss ON s.id = ss.store_id
            ${whereClause}
            ORDER BY ${orderBy}
        `;

        if (paginated) {
            const countRes = await db.query(`
                SELECT COUNT(*)::int AS total
                FROM products p
                JOIN stores s ON p.store_id = s.id
                LEFT JOIN store_settings ss ON s.id = ss.store_id
                ${whereClause}
            `, params);
            const total = countRes.rows[0]?.total ?? 0;
            const result = await db.query(`${baseQuery} LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, (page - 1) * limit]);
            const parseCurrencyRow = (currencyStr: any) => {
                try {
                    return typeof currencyStr === 'string' ? JSON.parse(currencyStr) : currencyStr;
                } catch (e) {
                    return { code: 'USD', symbol: '$', position: 'before' };
                }
            };
            return res.status(200).json({
                items: toCamelCase(result.rows.map(p => ({
                    ...sanitizeProduct(p),
                    store_name: p.store_name,
                    currency: parseCurrencyRow(p.store_currency)
                }))),
                total,
                page,
                pageSize: limit,
            });
        }

        const result = await db.query(`${baseQuery} LIMIT 100`, params);

        // Helper to parse currency safely
        const parseCurrency = (currencyStr: any) => {
            try {
                return typeof currencyStr === 'string' ? JSON.parse(currencyStr) : currencyStr;
            } catch (e) {
                return { code: 'USD', symbol: '$', position: 'before' };
            }
        };

        const sanitizedProducts = result.rows.map(p => ({
            ...sanitizeProduct(p),
            store_name: p.store_name,
            currency: parseCurrency(p.store_currency)
        }));
        res.status(200).json(toCamelCase(sanitizedProducts));
    } catch (error) {
        console.error('Error fetching global products:', error);
        res.status(500).json({ message: 'Failed to fetch products' });
    }
};

/**
 * Public order-status lookup for storefront customers.
 * GET /shop/:storeId/orders/:orderId?email=  (or ?phone=)
 *
 * Anti-enumeration: the order id alone is not enough — the caller must also
 * supply the email or phone that was used at checkout. Returns a minimal,
 * sanitized view (no internal customer ids, no cost prices).
 */
export const getShopOrderStatus = async (req: express.Request, res: express.Response) => {
    const { storeId, orderId } = req.params;
    const email = String(req.query.email || '').trim().toLowerCase();
    const phone = String(req.query.phone || '').replace(/\D/g, '');

    if (!email && !phone) {
        return res.status(400).json({ message: 'Provide the email or phone used at checkout.' });
    }

    try {
        const saleRes = await db.query(
            `SELECT transaction_id, "timestamp", total, subtotal, tax, delivery_fee,
                    payment_status, fulfillment_status, customer_details
             FROM sales
             WHERE transaction_id = $1 AND store_id = $2 AND channel = 'online'`,
            [orderId, storeId]
        );
        if (saleRes.rowCount === 0) {
            return res.status(404).json({ message: 'Order not found.' });
        }
        const sale = saleRes.rows[0];

        let details: any = {};
        try {
            details = typeof sale.customer_details === 'string'
                ? JSON.parse(sale.customer_details)
                : (sale.customer_details || {});
        } catch { /* keep empty */ }

        const detailEmail = String(details.email || '').trim().toLowerCase();
        const detailPhone = String(details.phone || '').replace(/\D/g, '');
        const emailMatches = !!email && !!detailEmail && detailEmail === email;
        const phoneMatches = !!phone && !!detailPhone && (detailPhone === phone || detailPhone.endsWith(phone) || phone.endsWith(detailPhone));

        if (!emailMatches && !phoneMatches) {
            // Same response as a miss — do not confirm the order exists.
            return res.status(404).json({ message: 'Order not found.' });
        }

        const itemsRes = await db.query(
            `SELECT si.quantity, si.price_at_sale, p.name
             FROM sale_items si
             LEFT JOIN products p ON si.product_id = p.id
             WHERE si.sale_id = $1 AND si.store_id = $2`,
            [orderId, storeId]
        );

        res.status(200).json(toCamelCase({
            order_id: sale.transaction_id,
            timestamp: sale.timestamp,
            total: parseFloat(sale.total),
            subtotal: parseFloat(sale.subtotal),
            tax: parseFloat(sale.tax),
            delivery_fee: parseFloat(sale.delivery_fee || 0),
            payment_status: sale.payment_status,
            fulfillment_status: sale.fulfillment_status,
            customer_name: details.name || null,
            items: itemsRes.rows.map(r => ({
                name: r.name || 'Item',
                quantity: parseFloat(r.quantity),
                price: parseFloat(r.price_at_sale),
            })),
        }));
    } catch (error) {
        console.error(`Error fetching order status ${orderId}:`, error);
        res.status(500).json({ message: 'Error fetching order status' });
    }
};
