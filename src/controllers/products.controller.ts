import express from 'express';
import db from '../db_client';
import { Product } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';
import { storageService } from '../services/storage.service';
import { MODULES, FREE_PRODUCT_LIMIT, isModuleEnabled } from '../services/entitlements.service';
import path from "path";
import fs from "fs";

// Helper function to handle file uploads and existing images
const processImageUrls = async (files: Express.Multer.File[], existingImages: string[] = []): Promise<string[]> => {
    const uploadPromises = files.map(file => storageService.uploadFile(file));
    const uploadedImageUrls = await Promise.all(uploadPromises);
    return [...existingImages, ...uploadedImageUrls];
};


// Helper function to delete old image files
const deleteImageFiles = async (imageUrls: string[]) => {
    const deletePromises = imageUrls.map(url => storageService.deleteFile(url));
    await Promise.all(deletePromises);
};


export const getProducts = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const { name, sku, categoryId, supplierId, stockStatus } = req.query as any;
        const where: string[] = [];
        const params: any[] = [];
        // Enforce tenant boundary first
        params.push(storeId); where.push(`store_id = $${params.length}`);
        if (name) { params.push(`%${name}%`); where.push(`LOWER(name) LIKE LOWER($${params.length})`); }
        if (sku) { params.push(`%${sku}%`); where.push(`LOWER(sku) LIKE LOWER($${params.length})`); }
        if (categoryId) { params.push(categoryId); where.push(`category_id = $${params.length}`); }
        if (supplierId) { params.push(supplierId); where.push(`supplier_id = $${params.length}`); }
        if (stockStatus) {
            const ss = String(stockStatus).toLowerCase();
            if (ss === 'out_of_stock') {
                where.push(`stock <= 0`);
            } else if (ss === 'in_stock') {
                where.push(`stock > 0`);
            } else if (ss === 'low_stock') {
                // low stock compared to reorder_point when set (>0) else compare to default threshold 0
                where.push(`(reorder_point IS NOT NULL AND stock <= reorder_point)`);
            }
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const result = await db.query(`SELECT * FROM products ${whereSql} ORDER BY name ASC`, params);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching products:', error);
        res.status(500).json({ message: 'Error fetching products' });
    }
};

export const getProductById = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const result = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [req.params.id, storeId]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error(`Error fetching product ${req.params.id}:`, error);
        res.status(500).json({ message: 'Error fetching product' });
    }
};

export const createProduct = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }

        // Freemium product cap: the free core allows FREE_PRODUCT_LIMIT products;
        // going beyond needs the Unlimited Products add-on (402 -> upgrade prompt).
        if (!(await isModuleEnabled(storeId, MODULES.UNLIMITED_PRODUCTS))) {
            const countRes = await db.query('SELECT COUNT(*)::int AS c FROM products WHERE store_id = $1', [storeId]);
            if ((countRes.rows[0]?.c ?? 0) >= FREE_PRODUCT_LIMIT) {
                return res.status(402).json({
                    message: `Your free plan includes ${FREE_PRODUCT_LIMIT} products. Unlock Unlimited Products to add more.`,
                    code: 'MODULE_LOCKED',
                    module: MODULES.UNLIMITED_PRODUCTS,
                });
            }
        }

        console.log('Creating product with data:', req.body);
        console.log('Files received:', req.files);

        const {
            name, description, sku, barcode, category_id, price, cost_price, stock,
            supplier_id, brand, reorder_point, status, custom_attributes,
            unit_of_measure, unitOfMeasure,
            weight, dimensions, safety_stock, safetyStock, variants,
            carton_price, units_per_carton, cartons_received
        } = req.body;

        const files = req.files as Express.Multer.File[];
        const id = generateId('prod');




        // Input validation
        if (!name || !category_id || !price) {
            return res.status(400).json({
                message: 'Missing required fields: name, category_id, and price are required'
            });
        }

        // For new products, we only handle direct file uploads.
        const allImageUrls = await processImageUrls(files || []);
        // Handle null/undefined values properly with better validation
        const processedValues = {
            name: name?.trim() || '',
            description: description?.trim() || '',
            sku: sku?.trim() || '',
            barcode: barcode?.trim() || null,
            categoryId: category_id?.trim() || null,
            supplierId: supplier_id?.trim() || null,
            price: price && price.toString().trim() ? parseFloat(price.toString()) : 0,
            costPrice: cost_price && cost_price.toString().trim() ? parseFloat(cost_price.toString()) : null,
            stock: stock && stock.toString().trim() ? parseFloat(stock.toString()) : 0,
            imageUrls: allImageUrls,
            brand: brand?.trim() || '',
            status: status || 'active',
            reorderPoint: reorder_point && reorder_point.toString().trim() ? parseInt(reorder_point.toString(), 10) : null,
            customAttributes: custom_attributes ?
                (typeof custom_attributes === 'string' ? JSON.parse(custom_attributes) : custom_attributes) : {},
            unitOfMeasure: (unit_of_measure || unitOfMeasure || 'unit').toString().toLowerCase() === 'kg' ? 'kg' : 'unit',
            weight: weight && weight.toString().trim() ? parseFloat(weight.toString()) : null,
            dimensions: dimensions?.toString().trim() || null,
            safetyStock: (safety_stock ?? safetyStock) && (safety_stock ?? safetyStock).toString().trim() ? parseInt((safety_stock ?? safetyStock).toString(), 10) : null,
            variants: (() => {
                if (!variants) return [];
                try {
                    const v = typeof variants === 'string' ? JSON.parse(variants) : variants;
                    return Array.isArray(v) ? v : [];
                } catch {
                    return [];
                }
            })(),
            // Carton / bulk pricing
            cartonPrice: carton_price && carton_price.toString().trim() ? parseFloat(carton_price.toString()) : null,
            unitsPerCarton: units_per_carton && units_per_carton.toString().trim() ? parseInt(units_per_carton.toString(), 10) : null,
            cartonsReceived: cartons_received && cartons_received.toString().trim() ? parseInt(cartons_received.toString(), 10) : null,
        };

        // Additional validation
        if (processedValues.price <= 0) {
            return res.status(400).json({ message: 'Price must be greater than 0' });
        }

        if (processedValues.stock < 0) {
            return res.status(400).json({ message: 'Stock cannot be negative' });
        }

        const queryText = `
            INSERT INTO products(id, name, description, sku, barcode, category_id, supplier_id, price, cost_price, stock, unit_of_measure, image_urls, brand, status, reorder_point, weight, dimensions, safety_stock, variants, custom_attributes, store_id, carton_price, units_per_carton, cartons_received)
            VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24)
            RETURNING *;
        `;
        const values = [
            id,
            processedValues.name,
            processedValues.description,
            processedValues.sku,
            processedValues.barcode,
            processedValues.categoryId,
            processedValues.supplierId,
            processedValues.price,
            processedValues.costPrice,
            processedValues.stock,
            processedValues.unitOfMeasure,
            processedValues.imageUrls,
            processedValues.brand,
            processedValues.status,
            processedValues.reorderPoint,
            processedValues.weight,
            processedValues.dimensions,
            processedValues.safetyStock,
            JSON.stringify(processedValues.variants || []),
            JSON.stringify(processedValues.customAttributes),
            storeId,
            processedValues.cartonPrice,
            processedValues.unitsPerCarton,
            processedValues.cartonsReceived,
        ];

        console.log('Executing query with values:', values);

        const client = await (db as any)._pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(queryText, values);
            const createdProduct = result.rows[0];

            if (processedValues.stock > 0 && (processedValues.costPrice || 0) > 0) {
                await accountingService.recordStockAdjustment(
                    toCamelCase(createdProduct),
                    0, // oldQuantity was 0
                    'Initial Stock',
                    client,
                    storeId
                );
            }

            await client.query('COMMIT');
            await auditService.log(req.user!, 'Product Created', `Product: "${createdProduct.name}" (SKU: ${createdProduct.sku})`);
            res.status(201).json(toCamelCase(createdProduct));
        } catch (innerError) {
            await client.query('ROLLBACK');
            throw innerError;
        } finally {
            client.release();
        }
    } catch (error) {
        // If database operation fails, clean up uploaded files
        const files = req.files as Express.Multer.File[];
        // Since we don't have the URLs here easily if they were just uploaded, 
        // and processImageUrls is what uploads them, we might have stranded files in storage if the DB insert fails.
        // To fix this properly, we would need to track the uploaded URLs.
        // For now, let's just log it or we'd need to refactor to upload AFTER DB check, but we need URLs for DB.
        // A better approach is to not do anything here or catch specific upload errors.
        // However, if we migrated to storageService, we can't easily "undo" without the URLs. 
        // Effectively, we can't delete them here easily without the URLs returned by processImageUrls.
        // So we will remove this cleanup block or update it if we had the URLs.
        // For this implementation, we will skip cleanup on error to keep it simple, or we'd need to move upload logic.
        // Let's comment out the old cleanup logic as it's for local files.
        // if (files && files.length > 0) {
        //    deleteImageFiles(files.map(file => `/uploads/products/${file.filename}`));
        // }

        // Handle known DB errors more gracefully
        const pgErr = error as any;
        if (pgErr && pgErr.code === '23505') { // unique_violation
            const constraint: string = pgErr.constraint || '';

            // Idempotency support: when a client retries a successful create
            // (e.g. after a network blip lost the original response), we hit
            // this branch because the SKU/barcode is already in our table.
            // Include the existing row in the response so the caller can
            // reconcile its `local-*` placeholder with the canonical record.
            const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
            const sku = (req.body?.sku || '').toString().trim();
            const barcode = (req.body?.barcode || '').toString().trim();
            let existing: any = null;
            if (storeId) {
                try {
                    if (constraint.includes('sku') && sku) {
                        const r = await db.query(
                            'SELECT * FROM products WHERE store_id = $1 AND sku = $2',
                            [storeId, sku],
                        );
                        existing = r.rows[0] || null;
                    } else if (constraint.includes('barcode') && barcode) {
                        const r = await db.query(
                            'SELECT * FROM products WHERE store_id = $1 AND barcode = $2',
                            [storeId, barcode],
                        );
                        existing = r.rows[0] || null;
                    }
                } catch { /* best-effort lookup; fall through */ }
            }

            if (constraint.includes('sku')) {
                return res.status(409).json({
                    message: 'A product with this SKU already exists. Please use a unique SKU.',
                    existingProduct: existing ? toCamelCase(existing) : null,
                });
            }
            if (constraint.includes('barcode')) {
                return res.status(409).json({
                    message: 'A product with this barcode already exists.',
                    existingProduct: existing ? toCamelCase(existing) : null,
                });
            }
            return res.status(409).json({ message: 'Duplicate value violates a unique constraint.' });
        }

        console.error('Error creating product:', error);
        console.error('Error details:', {
            message: (error as Error).message,
            stack: (error as Error).stack,
            requestBody: req.body
        });
        res.status(500).json({
            message: 'Error creating product',
            error: process.env.NODE_ENV === 'development' ? (error as Error).message : 'Internal server error'
        });
    }
};

export const updateProduct = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;

    console.log('Request body:', req.body);
    console.log('Files:', req.files);

    // Handle both snake_case (from FormData) and camelCase (from JSON)
    const body = req.body;
    const name = body.name;
    const description = body.description;
    const sku = body.sku;
    const barcode = body.barcode;
    const category_id = body.category_id || body.categoryId;
    const supplier_id = body.supplier_id || body.supplierId;
    const price = body.price;
    const cost_price = body.cost_price || body.costPrice;
    const stock = body.stock;
    const brand = body.brand;
    const status = body.status;
    const reorder_point = body.reorder_point || body.reorderPoint;
    const custom_attributes = body.custom_attributes || body.customAttributes;
    const unit_of_measure = body.unit_of_measure || body.unitOfMeasure;
    const weight = body.weight;
    const dimensions = body.dimensions;
    const safety_stock = body.safety_stock || body.safetyStock;
    const variants = body.variants;
    const existing_images = body.existing_images;
    const images_to_delete = body.images_to_delete;
    const carton_price = body.carton_price || body.cartonPrice;
    const units_per_carton = body.units_per_carton || body.unitsPerCarton;
    const cartons_received = body.cartons_received || body.cartonsReceived;

    const files = (req.files as Express.Multer.File[]) || [];

    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        // Fetch the FULL current row so we can fall back to existing values
        // for any column the caller didn't include in the request body.
        // Without this, PUT acts as a destructive replace — sending an
        // update that omits `stock` would null it out and violate the
        // NOT NULL constraint. Required for partial updates (e.g. the
        // desktop client updating only box config, or only price).
        const currentProductResult = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [id, storeId]);
        if (currentProductResult.rowCount === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }

        const currentRow = currentProductResult.rows[0];
        const oldStock = parseFloat(currentRow.stock || 0);
        const oldCost = parseFloat(currentRow.cost_price || 0);
        const oldInventoryValue = oldStock * oldCost;

        const dbImageUrls = currentRow.image_urls;
        let currentImageUrls: string[] = [];
        if (Array.isArray(dbImageUrls)) {
            currentImageUrls = dbImageUrls;
        } else if (typeof dbImageUrls === 'string') {
            try {
                currentImageUrls = JSON.parse(dbImageUrls);
            } catch (e) {
                console.error('Error parsing image_urls from DB, treating as empty:', e);
            }
        }

        let finalImageUrls: string[] = body.imageUrls || currentImageUrls;

        // This logic is for multipart/form-data requests which is the primary way to update products with images
        if (files.length > 0 || images_to_delete || existing_images) {
            let existingImageUrls: string[] = [];
            if (existing_images) {
                try {
                    existingImageUrls = typeof existing_images === 'string' ? JSON.parse(existing_images) : existing_images;
                } catch (e) { console.error('Error parsing existing_images:', e); existingImageUrls = currentImageUrls; }
            } else {
                existingImageUrls = currentImageUrls;
            }

            let imagesToDeleteArr: string[] = [];
            if (images_to_delete) {
                try {
                    imagesToDeleteArr = typeof images_to_delete === 'string' ? JSON.parse(images_to_delete) : images_to_delete;
                    existingImageUrls = existingImageUrls.filter(url => !imagesToDeleteArr.includes(url));
                    await deleteImageFiles(imagesToDeleteArr);
                } catch (e) { console.error('Error parsing images_to_delete:', e); }
            }

            // const base64Images = existingImageUrls.filter(url => url.startsWith('data:image'));
            const regularUrls = existingImageUrls.filter(url => !url.startsWith('data:image'));
            finalImageUrls = await processImageUrls(files, [...regularUrls]);
        }

        let customAttributesObj = {};
        if (custom_attributes) {
            try {
                customAttributesObj = typeof custom_attributes === 'string' ? JSON.parse(custom_attributes) : custom_attributes;
            } catch (e) { console.error('Error parsing custom_attributes:', e); }
        }

        const queryText = `
            UPDATE products
            SET name = $1, description = $2, sku = $3, barcode = $4, category_id = $5, supplier_id = $6, price = $7,
                cost_price = $8, stock = $9, unit_of_measure = $10, image_urls = $11, brand = $12, status = $13, reorder_point = $14,
                custom_attributes = $15, weight = $16, dimensions = $17, safety_stock = $18, variants = $19,
                carton_price = $20, units_per_carton = $21, cartons_received = $22
            WHERE id = $23 AND store_id = $24
            RETURNING *;
        `;

        // Helper: pick the body value if it was supplied (non-undefined/non-empty),
        // otherwise fall back to whatever is currently in the DB. Treats empty
        // strings as "not provided" since multipart form-data tends to send "".
        const pick = <T>(bodyVal: any, dbVal: T, transform?: (v: any) => T): T => {
            if (bodyVal === undefined || bodyVal === null || bodyVal === '') return dbVal;
            return transform ? transform(bodyVal) : (bodyVal as T);
        };

        // Variants comes in as a JSON-encoded string from multipart and as a
        // raw array from JSON requests — normalize either to a string column.
        const variantsValue = variants === undefined || variants === null
            ? currentRow.variants
            : (() => {
                  try {
                      return JSON.stringify(
                          typeof variants === 'string' ? JSON.parse(variants) : variants,
                      );
                  } catch {
                      return currentRow.variants;
                  }
              })();

        const customAttrsValue = custom_attributes === undefined
            ? currentRow.custom_attributes
            : JSON.stringify(customAttributesObj);

        const values = [
            pick(name, currentRow.name),
            pick(description, currentRow.description),
            pick(sku, currentRow.sku),
            pick(barcode, currentRow.barcode),
            pick(category_id, currentRow.category_id),
            pick(supplier_id, currentRow.supplier_id),
            pick(price, currentRow.price, (v) => parseFloat(v.toString())),
            pick(cost_price, currentRow.cost_price, (v) => parseFloat(v.toString())),
            pick(stock, currentRow.stock, (v) => parseFloat(v.toString())),
            pick(
                unit_of_measure,
                currentRow.unit_of_measure || 'unit',
                (v) => (v.toString().toLowerCase() === 'kg' ? 'kg' : 'unit'),
            ),
            // image_urls: if the request didn't touch images at all, preserve
            // existing. The earlier block already handles the file/delete case
            // and writes finalImageUrls accordingly.
            (files.length > 0 || images_to_delete || existing_images || body.imageUrls)
                ? finalImageUrls
                : currentRow.image_urls,
            pick(brand, currentRow.brand),
            pick(status, currentRow.status || 'active'),
            pick(reorder_point, currentRow.reorder_point, (v) => parseInt(v.toString(), 10)),
            customAttrsValue,
            pick(weight, currentRow.weight, (v) => parseFloat(v.toString())),
            pick(dimensions, currentRow.dimensions),
            pick(safety_stock, currentRow.safety_stock, (v) => parseInt(v.toString(), 10)),
            variantsValue,
            // Carton / bulk pricing
            pick(carton_price, currentRow.carton_price, (v) => parseFloat(v.toString())),
            pick(units_per_carton, currentRow.units_per_carton, (v) => parseInt(v.toString(), 10)),
            pick(cartons_received, currentRow.cartons_received, (v) => parseInt(v.toString(), 10)),
            id,
            storeId,
        ];

        const client = await (db as any)._pool.connect();
        try {
            await client.query('BEGIN');
            const result = await client.query(queryText, values);
            if (result.rowCount === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({ message: 'Product not found' });
            }

            const updatedProduct = result.rows[0];
            const newStock = parseFloat(updatedProduct.stock || 0);
            const newCost = parseFloat(updatedProduct.cost_price || 0);
            const newInventoryValue = newStock * newCost;
            const valueDiff = newInventoryValue - oldInventoryValue;

            if (Math.abs(valueDiff) > 0.01) {
                await accountingService.recordConsolidatedStockAdjustment(
                    valueDiff,
                    `Manual adjustment for ${updatedProduct.name}`,
                    client,
                    storeId
                );
            }

            await client.query('COMMIT');
            await auditService.log(req.user!, 'Product Updated', `Product: "${updatedProduct.name}" (ID: ${updatedProduct.id})`);
            res.status(200).json(toCamelCase(updatedProduct));
        } catch (innerError) {
            await client.query('ROLLBACK');
            throw innerError;
        } finally {
            client.release();
        }
    } catch (error) {
        if (files.length > 0) {
            // Memory storage, files not saved if error occurs before upload call, 
            // or if we fail after upload we would need URLs to delete. 
            // deleteImageFiles(files.map(file => `/uploads/products/${file.filename}`));
        }
        const pgErr = error as any;
        if (pgErr && pgErr.code === '23505') { // unique_violation
            const constraint: string = pgErr.constraint || '';
            if (constraint.includes('sku')) {
                return res.status(409).json({ message: 'A product with this SKU already exists. Please use a unique SKU.' });
            }
            if (constraint.includes('barcode')) {
                return res.status(409).json({ message: 'A product with this barcode already exists.' });
            }
            return res.status(409).json({ message: 'Duplicate value violates a unique constraint.' });
        }
        console.error(`Error updating product ${id}:`, error);
        res.status(500).json({ message: 'Error updating product', error: (error as Error).message });
    }
};
// ... rest of your existing controller functions
// export const updateProduct = async (req: express.Request, res: express.Response) => {
//     const { id } = req.params;
//     const {
//         name, description, sku, barcode, categoryId, supplierId, price, costPrice, stock, imageUrls,
//         brand, status, reorderPoint, customAttributes
//     } = req.body;
//
//     const queryText = `
//         UPDATE products
//         SET name = $1, description = $2, sku = $3, barcode = $4, category_id = $5, supplier_id = $6, price = $7,
//             cost_price = $8, stock = $9, image_urls = $10, brand = $11, status = $12, reorder_point = $13,
//             custom_attributes = $14
//         WHERE id = $15
//         RETURNING *;
//     `;
//     const values = [
//         name, description, sku, barcode, categoryId, supplierId, price, costPrice, stock, imageUrls,
//         brand, status, reorderPoint, customAttributes, id
//     ];
//
//     try {
//         const result = await db.query(queryText, values);
//         if (result.rowCount === 0) {
//             return res.status(404).json({ message: 'Product not found' });
//         }
//         const updatedProduct = result.rows[0];
//         await auditService.log(req.user!, 'Product Updated', `Product: "${updatedProduct.name}" (ID: ${updatedProduct.id})`);
//         res.status(200).json(toCamelCase(updatedProduct));
//     } catch (error) {
//         console.error(`Error updating product ${id}:`, error);
//         res.status(500).json({ message: 'Error updating product' });
//     }
// };

export const deleteProduct = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const productInfoResult = await db.query('SELECT name, sku FROM products WHERE id = $1 AND store_id = $2', [id, storeId]);
        if (productInfoResult.rowCount === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }
        const deletedProductInfo = productInfoResult.rows[0];

        // Check for associated sales or purchase orders
        const saleUse = await db.query('SELECT COUNT(*)::int AS count FROM sale_items WHERE product_id = $1', [id]);
        const poUse = await db.query('SELECT COUNT(*)::int AS count FROM purchase_order_items WHERE product_id = $1', [id]);
        if ((saleUse.rows[0].count ?? 0) > 0 || (poUse.rows[0].count ?? 0) > 0) {
            return res.status(400).json({
                message: 'Cannot permanently delete this product because it has associated sales or purchase order history. Please archive it instead.'
            });
        }

        await db.query('DELETE FROM products WHERE id = $1 AND store_id = $2', [id, storeId]);

        await auditService.log(req.user!, 'Product Deleted', `Product: "${deletedProductInfo.name}" (SKU: ${deletedProductInfo.sku})`);
        res.status(200).json({ message: 'Product deleted' });
    } catch (error) {
        console.error(`Error deleting product ${id}:`, error);
        res.status(500).json({ message: 'Error deleting product' });
    }
};

export const archiveProduct = async (req: express.Request, res: express.Response) => {
    const { id } = req.params;
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const productResult = await db.query('SELECT status, name FROM products WHERE id = $1 AND store_id = $2', [id, storeId]);
        if (productResult.rowCount === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }

        const product = productResult.rows[0];

        // Idempotency: clients can pass `targetStatus` in the body to set an
        // absolute state instead of relying on a toggle. This makes the call
        // safe to retry — re-sending the same target produces the same final
        // state regardless of how many times it lands at the server.
        //
        // Fallback: if `targetStatus` is missing or malformed, behave the
        // way old callers expect (toggle the current state).
        const requested = (req.body && (req.body as any).targetStatus) as
            | string
            | undefined;
        const validTargets = ['active', 'archived'];
        const newStatus = (requested && validTargets.includes(requested))
            ? requested
            : (product.status === 'active' ? 'archived' : 'active');

        // No-op when already in the target state. Return the current row so
        // the client can update its mirror; skip the audit log entry since
        // nothing changed.
        if (product.status === newStatus) {
            const current = await db.query(
                'SELECT * FROM products WHERE id = $1 AND store_id = $2',
                [id, storeId],
            );
            return res.status(200).json(toCamelCase(current.rows[0]));
        }

        const updateResult = await db.query('UPDATE products SET status = $1 WHERE id = $2 AND store_id = $3 RETURNING *', [newStatus, id, storeId]);

        const action = newStatus === 'archived' ? 'Product Archived' : 'Product Restored';
        await auditService.log(req.user!, action, `Product: "${product.name}" (ID: ${id})`);

        res.status(200).json(toCamelCase(updateResult.rows[0]));
    } catch (error) {
        console.error(`Error archiving product ${id}:`, error);
        res.status(500).json({ message: 'Error updating product status' });
    }
};

export const adjustStock = async (req: express.Request, res: express.Response) => {
    const { newQuantity, reason } = req.body as { newQuantity: number; reason: string };
    const { id } = req.params;

    if (typeof newQuantity !== 'number' || isNaN(newQuantity) || !reason) {
        return res.status(400).json({ message: 'newQuantity (number) and reason (string) are required.' });
    }

    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const productResult = await db.query('SELECT * FROM products WHERE id = $1 AND store_id = $2', [id, storeId]);
        if (productResult.rowCount === 0) {
            return res.status(404).json({ message: 'Product not found' });
        }
        const product = productResult.rows[0];
        const oldQuantity: number = Number(product.stock) || 0;

        let finalStock: number;
        let delta: number | null = null;

        if (reason === 'Stock Count') {
            // Absolute set; must be non-negative
            if (newQuantity < 0) {
                return res.status(400).json({ message: 'Stock Count cannot be negative.' });
            }
            finalStock = newQuantity;
            delta = finalStock - oldQuantity;
        } else if (reason === 'Quick adjustment') {
            // Quick +/- buttons send absolute stock
            finalStock = newQuantity;
            delta = finalStock - oldQuantity;
        } else {
            // Treat input as signed delta; clamp at 0
            delta = newQuantity;
            finalStock = Math.max(0, oldQuantity + newQuantity);
        }

        if (!Number.isFinite(finalStock)) {
            return res.status(400).json({ message: 'Invalid resulting stock level.' });
        }

        const updateResult = await db.query('UPDATE products SET stock = $1 WHERE id = $2 AND store_id = $3 RETURNING *', [finalStock, id, storeId]);

        const actionDetail = delta === null ? '' : ` | Change: ${delta >= 0 ? '+' : ''}${delta}`;
        await auditService.log(
            req.user!,
            'Stock Adjusted',
            `Product: "${product.name}" | From: ${oldQuantity} To: ${finalStock}${actionDetail} | Reason: ${reason}`
        );

        await accountingService.recordStockAdjustment(updateResult.rows[0], oldQuantity, reason, undefined, storeId);

        // --- Low Stock Check ---
        const updated = updateResult.rows[0];
        if (updated.reorder_point !== null && finalStock <= parseFloat(updated.reorder_point)) {
            try {
                const title = "Low Stock Alert ⚠️";
                const message = `Low stock: ${updated.name} (${finalStock} left). Reorder at: ${updated.reorder_point}. Adjusted by: ${req.user!.name}`;

                const { pushService } = await import('../services/push.service');
                await pushService.sendToStore(storeId, {
                    title: title,
                    body: message,
                    url: `/inventory`
                });
            } catch (e) {
                console.error('Low stock push failed for manual adjustment:', e);
            }
        }

        res.status(200).json(toCamelCase(updated));
    } catch (error) {
        console.error(`Error adjusting stock for product ${id}:`, error);
        res.status(500).json({ message: 'Error adjusting stock' });
    }
};

import { externalProductService } from '../services/externalProduct.service';

export const lookupExternalProduct = async (req: express.Request, res: express.Response) => {
    const { barcode } = req.params;
    try {
        if (!barcode) {
            return res.status(400).json({ message: 'Barcode is required' });
        }

        const productData = await externalProductService.lookupByBarcode(barcode);

        if (!productData) {
            return res.status(404).json({ message: 'Product not found externally' });
        }

        res.status(200).json(productData);
    } catch (error) {
        console.error(`Error looking up external product ${barcode}:`, error);
        res.status(500).json({ message: 'Error performing external lookup' });
    }
};
