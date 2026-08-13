import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { accountingService } from '../services/accounting.service';
import { MODULES, FREE_PRODUCT_LIMIT, isModuleEnabled } from '../services/entitlements.service';

/**
 * Bulk product import (CSV).
 *
 * The client parses the file and posts rows as JSON; every value is validated
 * and coerced again here, because the browser is not a trustworthy source of
 * prices or stock levels. One transaction covers the whole import: either the
 * catalogue takes the whole file or it takes none of it, so a failure halfway
 * through can't leave a half-imported catalogue behind.
 *
 * Row-level problems (a missing name, a negative price) are *not* fatal — they
 * are reported per line so the operator can fix the spreadsheet, while the good
 * rows still land. Only an unexpected failure rolls everything back.
 */

const MAX_ROWS = 2000;

export interface ImportRow {
    name?: string;
    sku?: string;
    barcode?: string;
    category?: string;
    price?: string | number;
    costPrice?: string | number;
    stock?: string | number;
    description?: string;
    brand?: string;
    unitOfMeasure?: string;
    reorderPoint?: string | number;
}

interface RowOutcome {
    /** 1-based line number as it appeared in the file (header excluded). */
    row: number;
    name: string;
    action: 'create' | 'update' | 'skip' | 'error';
    message?: string;
}

const num = (v: unknown): number | null => {
    if (v === undefined || v === null) return null;
    const s = String(v).trim().replace(/,/g, '');
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
};

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Validates and normalises one row. Returns either a clean product payload or a
 * human-readable reason the line can't be imported.
 */
const parseRow = (raw: ImportRow): { ok: true; value: any } | { ok: false; reason: string } => {
    const name = text(raw.name);
    if (!name) return { ok: false, reason: 'Name is required.' };

    // A price-less row is legitimate: supplier catalogues and "stock this later"
    // lists arrive without one. The product is recorded unpriced (0) and stays
    // off the POS until someone prices it.
    const price = num(raw.price) ?? 0;
    if (price < 0) return { ok: false, reason: 'Price cannot be negative.' };

    const costPrice = num(raw.costPrice);
    if (costPrice !== null && costPrice < 0) return { ok: false, reason: 'Cost price cannot be negative.' };

    const stock = num(raw.stock) ?? 0;
    if (stock < 0) return { ok: false, reason: 'Stock cannot be negative.' };

    const reorderPoint = num(raw.reorderPoint);
    if (reorderPoint !== null && reorderPoint < 0) return { ok: false, reason: 'Reorder point cannot be negative.' };

    const unit = text(raw.unitOfMeasure).toLowerCase();

    return {
        ok: true,
        value: {
            name,
            sku: text(raw.sku),
            barcode: text(raw.barcode) || null,
            categoryName: text(raw.category),
            price,
            costPrice,
            stock,
            description: text(raw.description),
            brand: text(raw.brand),
            unitOfMeasure: unit === 'kg' ? 'kg' : 'unit',
            reorderPoint: reorderPoint === null ? null : Math.round(reorderPoint),
        },
    };
};

export const importProducts = async (req: express.Request, res: express.Response) => {
    const { rows, updateExisting = false, dryRun = false } = req.body as {
        rows?: ImportRow[];
        updateExisting?: boolean;
        dryRun?: boolean;
    };

    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'Store context required' });

    if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(400).json({ message: 'No rows to import. Check the file has a header row and at least one product.' });
    }
    if (rows.length > MAX_ROWS) {
        return res.status(400).json({
            message: `That file has ${rows.length} rows. Import at most ${MAX_ROWS} at a time.`,
        });
    }

    const client = await (db as any)._pool.connect();
    try {
        // Existing catalogue, keyed for duplicate detection. SKU is unique per
        // store (uidx_products_store_sku), so it's the identity we match on;
        // name is the fallback for files that carry no SKU column.
        const existing = await client.query(
            'SELECT id, name, sku FROM products WHERE store_id = $1',
            [storeId],
        );
        const bySku = new Map<string, string>();
        const byName = new Map<string, string>();
        for (const p of existing.rows) {
            if (p.sku) bySku.set(String(p.sku).trim().toLowerCase(), p.id);
            byName.set(String(p.name).trim().toLowerCase(), p.id);
        }

        // Classify every row first, so the caller can be told exactly what will
        // happen before anything is written (this is what dryRun surfaces).
        const outcomes: RowOutcome[] = [];
        const toCreate: any[] = [];
        const toUpdate: { id: string; value: any }[] = [];
        // Guards against a file that lists the same product twice.
        const seenInFile = new Set<string>();

        rows.forEach((raw, i) => {
            const parsed = parseRow(raw || {});
            const line = i + 1;
            if (!parsed.ok) {
                outcomes.push({ row: line, name: text(raw?.name) || '(no name)', action: 'error', message: parsed.reason });
                return;
            }
            const value = parsed.value;
            const skuKey = value.sku.toLowerCase();
            const nameKey = value.name.toLowerCase();
            const fileKey = skuKey || nameKey;

            if (seenInFile.has(fileKey)) {
                outcomes.push({ row: line, name: value.name, action: 'skip', message: 'Duplicate of an earlier row in this file.' });
                return;
            }
            seenInFile.add(fileKey);

            const existingId = (skuKey && bySku.get(skuKey)) || byName.get(nameKey);
            if (existingId) {
                if (!updateExisting) {
                    outcomes.push({ row: line, name: value.name, action: 'skip', message: 'Already in your catalogue.' });
                    return;
                }
                toUpdate.push({ id: existingId, value });
                outcomes.push({ row: line, name: value.name, action: 'update' });
                return;
            }
            toCreate.push(value);
            outcomes.push({ row: line, name: value.name, action: 'create' });
        });

        // Freemium product cap — the same rule single creation enforces, applied
        // to the whole batch so an import can't slip past it a row at a time.
        if (toCreate.length > 0 && !(await isModuleEnabled(storeId, MODULES.UNLIMITED_PRODUCTS))) {
            const current = existing.rowCount ?? 0;
            if (current + toCreate.length > FREE_PRODUCT_LIMIT) {
                return res.status(402).json({
                    message: `Your free plan includes ${FREE_PRODUCT_LIMIT} products. This file would take you to `
                        + `${current + toCreate.length}. Unlock Unlimited Products to import them all.`,
                    code: 'MODULE_LOCKED',
                    module: MODULES.UNLIMITED_PRODUCTS,
                    wouldCreate: toCreate.length,
                    currentCount: current,
                });
            }
        }

        const summary = {
            created: toCreate.length,
            updated: toUpdate.length,
            skipped: outcomes.filter(o => o.action === 'skip').length,
            errors: outcomes.filter(o => o.action === 'error').length,
        };

        if (dryRun) {
            return res.status(200).json({ dryRun: true, ...summary, outcomes });
        }

        await client.query('BEGIN');

        // Categories are resolved by name, creating any that don't exist yet, so
        // a spreadsheet can introduce its own categories. Cached per request to
        // avoid re-querying for every row of the same category.
        const categoryCache = new Map<string, string>();
        const resolveCategory = async (rawName: string): Promise<string> => {
            const wanted = (rawName || 'Uncategorized').trim() || 'Uncategorized';
            const key = wanted.toLowerCase();
            const cached = categoryCache.get(key);
            if (cached) return cached;

            const found = await client.query(
                'SELECT id FROM categories WHERE store_id = $1 AND LOWER(TRIM(name)) = $2 LIMIT 1',
                [storeId, key],
            );
            if ((found.rowCount ?? 0) > 0) {
                categoryCache.set(key, found.rows[0].id);
                return found.rows[0].id;
            }
            const id = generateId('cat');
            await client.query(
                'INSERT INTO categories (id, name, store_id) VALUES ($1, $2, $3)',
                [id, wanted, storeId],
            );
            categoryCache.set(key, id);
            return id;
        };

        // Imported stock is inventory the store now owns, so it has to hit the
        // Inventory account like every other stock movement (creation, PO
        // receipt, adjustment, stock take) already does. Without this the
        // sub-ledger `SUM(stock * cost_price)` climbed with each import while
        // the GL stayed put, and the accounting hub's inventoryMatch check
        // failed permanently for any store that built its catalogue by import.
        let importValueDelta = 0;

        const created: any[] = [];
        for (const [index, value] of toCreate.entries()) {
            const categoryId = await resolveCategory(value.categoryName);
            const id = generateId('prod');
            // A blank SKU column is normal in supplier price lists; generate a
            // stable one rather than rejecting the row.
            const sku = value.sku || `IMP-${Date.now().toString().slice(-6)}-${index}`;
            const inserted = await client.query(
                `INSERT INTO products
                    (id, name, description, sku, barcode, category_id, price, cost_price, stock,
                     status, store_id, image_urls, brand, unit_of_measure, reorder_point)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,'{}',$11,$12,$13)
                 RETURNING *`,
                [
                    id, value.name, value.description, sku, value.barcode, categoryId,
                    value.price, value.costPrice, value.stock, storeId,
                    value.brand, value.unitOfMeasure, value.reorderPoint,
                ],
            );
            created.push(inserted.rows[0]);
            importValueDelta += (Number(value.stock) || 0) * (Number(value.costPrice) || 0);
        }

        for (const { id, value } of toUpdate) {
            const categoryId = value.categoryName ? await resolveCategory(value.categoryName) : null;
            const before = await client.query(
                'SELECT stock, cost_price FROM products WHERE id = $1 AND store_id = $2',
                [id, storeId],
            );
            const oldValue = (Number(before.rows[0]?.stock) || 0) * (Number(before.rows[0]?.cost_price) || 0);
            await client.query(
                `UPDATE products SET
                    name = $1,
                    description = COALESCE(NULLIF($2, ''), description),
                    barcode = COALESCE($3, barcode),
                    category_id = COALESCE($4, category_id),
                    price = $5,
                    cost_price = COALESCE($6, cost_price),
                    stock = $7,
                    brand = COALESCE(NULLIF($8, ''), brand),
                    unit_of_measure = $9,
                    reorder_point = COALESCE($10, reorder_point)
                 WHERE id = $11 AND store_id = $12`,
                [
                    value.name, value.description, value.barcode, categoryId,
                    value.price, value.costPrice, value.stock, value.brand,
                    value.unitOfMeasure, value.reorderPoint, id, storeId,
                ],
            );
            // cost_price is COALESCEd above, so a row that omits it keeps the
            // stored cost — read the row back rather than assuming the CSV's.
            const after = await client.query(
                'SELECT stock, cost_price FROM products WHERE id = $1 AND store_id = $2',
                [id, storeId],
            );
            const newValue = (Number(after.rows[0]?.stock) || 0) * (Number(after.rows[0]?.cost_price) || 0);
            importValueDelta += newValue - oldValue;
        }

        if (Math.abs(importValueDelta) > 0.01) {
            await accountingService.recordConsolidatedStockAdjustment(
                importValueDelta,
                `Product import (${summary.created} created, ${summary.updated} updated)`,
                client,
                storeId,
            );
        }

        await client.query('COMMIT');

        auditService.log(
            req.user!,
            'Products Imported',
            `CSV import: ${summary.created} created, ${summary.updated} updated, `
            + `${summary.skipped} skipped, ${summary.errors} rejected`,
        );

        res.status(200).json({
            ...summary,
            outcomes,
            products: toCamelCase(created),
        });
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch { /* nothing to roll back */ }
        console.error('Error importing products:', error);
        res.status(500).json({ message: 'Import failed. No products were changed.' });
    } finally {
        client.release();
    }
};
