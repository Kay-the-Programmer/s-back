import express from 'express';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';
import { accountingService } from '../services/accounting.service';

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
            'SELECT name, address, phone, email, website, currency, tax_rate, is_online_store_enabled, receipt_message FROM store_settings WHERE store_id = $1',
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

    try {
        let queryText = `
            SELECT * FROM products 
            WHERE store_id = $1 AND status = 'active'
        `;
        const params: any[] = [storeId];

        if (categoryId) {
            params.push(categoryId);
            queryText += ` AND category_id = $${params.length}`;
        }

        if (search) {
            params.push(`%${search}%`);
            queryText += ` AND (LOWER(name) LIKE LOWER($${params.length}) OR LOWER(description) LIKE LOWER($${params.length}))`;
        }

        queryText += ` ORDER BY name ASC`;

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
        const result = await db.query(
            'SELECT id, name, parent_id FROM categories WHERE store_id = $1 ORDER BY name ASC',
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
    const { cart, customerDetails } = req.body;

    if (!cart || cart.length === 0) {
        return res.status(400).json({ message: 'Cart cannot be empty' });
    }

    if (!customerDetails || !customerDetails.name) {
        return res.status(400).json({ message: 'Customer details (name) required' });
    }

    const client = await db._pool.connect();

    try {
        await client.query('BEGIN');

        // 1. Handle Customer (Find or Create)
        let customerId = null;
        if (customerDetails.email) {
            const customerRes = await client.query(
                'SELECT id FROM customers WHERE email = $1 AND store_id = $2',
                [customerDetails.email, storeId]
            );
            if ((customerRes.rowCount || 0) > 0) {
                customerId = customerRes.rows[0].id;
            } else {
                customerId = `cus_${Math.random().toString(36).substr(2, 9)}`;
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
            // Guest without email - maybe use phone or just create new generic guest
            // For now, always create a record if provided info
            customerId = `cus_${Math.random().toString(36).substr(2, 9)}`;
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

            // Validate quantity
            const quantity = parseFloat(item.quantity);
            if (isNaN(quantity) || quantity <= 0) {
                console.warn(`Invalid quantity for product ${productId}:`, item.quantity);
                continue;
            }

            const prodRes = await client.query(
                'SELECT id, price, cost_price, name, stock FROM products WHERE id = $1 AND store_id = $2',
                [productId, storeId]
            );

            if (prodRes.rowCount === 0) {
                console.warn(`Product not found during checkout: ${productId} for store ${storeId}`);
                continue;
            }
            const product = prodRes.rows[0];

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

        const taxRate = 0.10; // Placeholder, should fetch from store_settings
        const tax = subtotal * taxRate;
        const total = subtotal + tax;
        const transactionId = `ord_${Math.random().toString(36).substr(2, 9)}`;
        const timestamp = new Date().toISOString();

        // 3. Create Sale Record
        await client.query(
            `INSERT INTO sales (
                transaction_id, "timestamp", customer_id, total, subtotal, tax, discount, 
                payment_status, fulfillment_status, channel, customer_details, 
                amount_paid, refund_status, store_id
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
                transactionId, timestamp, customerId, total, subtotal, tax, 0,
                'unpaid', 'pending', 'online', JSON.stringify(customerDetails),
                0, 'none', storeId
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
            discount: 0,
            paymentStatus: 'unpaid',
            amountPaid: 0,
            cart: validItems,
            customerName: customerDetails.name
        };

        await accountingService.recordSale(saleForAccounting as any, client, storeId);

        await client.query('COMMIT');

        res.status(201).json({
            message: 'Order placed successfully',
            orderId: transactionId,
            total,
            status: 'pending'
        });

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
        const result = await db.query(`
            SELECT s.id, s.name, s.status, ss.address, ss.phone, ss.email, ss.website, ss.currency
            FROM stores s
            LEFT JOIN store_settings ss ON s.id = ss.store_id
            WHERE s.status = 'active' AND (ss.is_online_store_enabled IS NULL OR ss.is_online_store_enabled = TRUE)
        `);

        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching public stores:', error);
        res.status(500).json({ message: 'Failed to fetch stores' });
    }
};

export const getGlobalProducts = async (req: express.Request, res: express.Response) => {
    try {
        const result = await db.query(`
            SELECT p.*, s.name as store_name, ss.currency as store_currency
            FROM products p
            JOIN stores s ON p.store_id = s.id
            LEFT JOIN store_settings ss ON s.id = ss.store_id
            WHERE p.status = 'active' 
            AND s.status = 'active'
            AND (ss.is_online_store_enabled IS NULL OR ss.is_online_store_enabled = TRUE)
            ORDER BY p.name ASC
            LIMIT 100
        `);

        const sanitizedProducts = result.rows.map(p => ({
            ...sanitizeProduct(p),
            store_name: p.store_name,
            currency: p.store_currency
        }));
        res.status(200).json(toCamelCase(sanitizedProducts));
    } catch (error) {
        console.error('Error fetching global products:', error);
        res.status(500).json({ message: 'Failed to fetch products' });
    }
};
