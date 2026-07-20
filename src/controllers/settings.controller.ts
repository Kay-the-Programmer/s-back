import express from 'express';
import db from '../db_client';
import { auditService } from '../services/audit.service';
import { StoreSettings } from '../types';
import { toCamelCase } from '../utils/helpers';
import { isModuleEnabled, MODULES } from '../services/entitlements.service';

export const getSettings = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) {
            return res.status(400).json({ message: 'No store selected. Please select a store first.' });
        }

        const result = await db.query('SELECT * FROM store_settings WHERE store_id = $1', [storeId]);
        if (result.rowCount === 0) {
            // Create default settings for this store on first access
            // Pull store name from the stores table so the Settings module reflects the registered store name
            const storeRes = await db.query('SELECT name FROM stores WHERE id = $1', [storeId]);
            const registeredStoreName: string = storeRes.rows?.[0]?.name || 'My Store';

            const defaults: Partial<StoreSettings> = {
                name: registeredStoreName,
                address: '',
                phone: '',
                email: '',
                website: '',
                taxRate: 0,
                currency: { symbol: '$', code: 'USD', position: 'before' },
                receiptMessage: '',
                lowStockThreshold: 5,
                skuPrefix: 'SKU-',
                enableStoreCredit: false,
                paymentMethods: [
                    { id: 'cash', name: 'CASH' },
                    { id: 'airtel', name: 'AIRTEL' },
                    { id: 'mtn', name: 'MTN' }
                ],
                supplierPaymentMethods: [
                    { id: 'cash', name: 'CASH' },
                    { id: 'airtel', name: 'AIRTEL' },
                    { id: 'mtn', name: 'MTN' }
                ],
                lencoPublicKey: '',
                lencoSecretKey: ''
            };
            const insert = await db.query(
                `INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods, is_online_store_enabled, lenco_public_key, lenco_secret_key)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                 RETURNING *;`,
                [
                    storeId,
                    defaults.name,
                    defaults.address,
                    defaults.phone,
                    defaults.email,
                    defaults.website,
                    defaults.taxRate,
                    JSON.stringify(defaults.currency),
                    defaults.receiptMessage,
                    defaults.lowStockThreshold,
                    defaults.skuPrefix,
                    defaults.enableStoreCredit,
                    JSON.stringify(defaults.paymentMethods),
                    JSON.stringify(defaults.supplierPaymentMethods),
                    true, // Default is_online_store_enabled
                    defaults.lencoPublicKey,
                    defaults.lencoSecretKey
                ]
            );
            return res.status(200).json(toCamelCase(insert.rows[0]));
        }

        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error("Error fetching settings:", error);
        res.status(500).json({ message: "Error fetching settings" });
    }
};

/**
 * Upload/replace the store logo. Multipart single file ("logo") → storage
 * service (local /uploads volume or Cloudinary) → store_settings.logo_url.
 */
export const uploadStoreLogo = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) return res.status(400).json({ message: 'No store selected.' });
        const file = (req as any).file as Express.Multer.File | undefined;
        if (!file) return res.status(400).json({ message: 'No logo file received.' });
        if (!String(file.mimetype || '').startsWith('image/')) {
            return res.status(400).json({ message: 'The logo must be an image.' });
        }
        const { storageService } = await import('../services/storage.service');
        const url = await storageService.uploadFile(file);
        const result = await db.query(
            'UPDATE store_settings SET logo_url = $1 WHERE store_id = $2 RETURNING logo_url',
            [url, storeId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Store settings not found.' });
        }
        auditService.log(req.user!, 'Settings Updated', 'Store logo uploaded.');
        res.status(200).json({ logoUrl: result.rows[0].logo_url });
    } catch (error) {
        console.error('Error uploading store logo:', error);
        res.status(500).json({ message: 'Failed to upload logo' });
    }
};

export const updateSettings = async (req: express.Request, res: express.Response) => {
    const newSettings: StoreSettings = req.body;
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) {
            return res.status(400).json({ message: 'No store selected. Please select a store first.' });
        }

        // Monetization gate: connecting a Lenco account to accept mobile-money
        // payments through SalePilot requires the paid "Accept Mobile Money" add-on.
        // We block *newly setting or changing* a key when the store doesn't own the
        // add-on (superadmin bypasses) — the authoritative server-side chokepoint so
        // a store can't enable payment collection without unlocking it. Comparing
        // against the stored keys means an un-entitled store that already had keys
        // can still save unrelated settings (its POS mobile-money option stays
        // locked separately until the add-on is purchased).
        const newPub = String(newSettings.lencoPublicKey || '').trim();
        const newSec = String(newSettings.lencoSecretKey || '').trim();
        if ((newPub || newSec) && req.user?.role !== 'superadmin') {
            const cur = await db.query('SELECT lenco_public_key, lenco_secret_key FROM store_settings WHERE store_id = $1', [storeId]);
            const curPub = (cur.rows[0]?.lenco_public_key || '').trim();
            const curSec = (cur.rows[0]?.lenco_secret_key || '').trim();
            const connectingNewKeys = (newPub && newPub !== curPub) || (newSec && newSec !== curSec);
            if (connectingNewKeys && !(await isModuleEnabled(storeId, MODULES.PAYMENT_GATEWAY))) {
                return res.status(402).json({
                    message: 'Connecting a mobile-money account requires the “Accept Mobile Money” add-on. Unlock it to process payments through SalePilot.',
                    module: MODULES.PAYMENT_GATEWAY,
                    action: 'upgrade',
                });
            }
        }

        // Ensure taxRate is never null - default to 0 if not provided
        if (newSettings.taxRate === null || newSettings.taxRate === undefined) {
            newSettings.taxRate = 0;
        }

        // Ensure lowStockThreshold is never null - default to 5 if not provided
        if (newSettings.lowStockThreshold === null || newSettings.lowStockThreshold === undefined) {
            newSettings.lowStockThreshold = 5;
        }

        // Ensure enableStoreCredit is never null - default to false if not provided
        // Using Boolean conversion to ensure it's always a boolean value
        newSettings.enableStoreCredit = newSettings.enableStoreCredit === true;

        const query = `
            INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods, is_online_store_enabled, lenco_public_key, lenco_secret_key, is_wholesale_supplier, delivery_fee, free_delivery_above, store_description)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, COALESCE($18, FALSE), COALESCE($19, 0), $20, $21)
            ON CONFLICT (store_id) DO UPDATE SET
                                           name = EXCLUDED.name,
                                           address = EXCLUDED.address,
                                           phone = EXCLUDED.phone,
                                           email = EXCLUDED.email,
                                           website = EXCLUDED.website,
                                           tax_rate = EXCLUDED.tax_rate,
                                           currency = EXCLUDED.currency,
                                           receipt_message = EXCLUDED.receipt_message,
                                           low_stock_threshold = EXCLUDED.low_stock_threshold,
                                           sku_prefix = EXCLUDED.sku_prefix,
                                           enable_store_credit = EXCLUDED.enable_store_credit,
                                           payment_methods = EXCLUDED.payment_methods,
                                           supplier_payment_methods = EXCLUDED.supplier_payment_methods,
                                           is_online_store_enabled = EXCLUDED.is_online_store_enabled,
                                           lenco_public_key = EXCLUDED.lenco_public_key,
                                           lenco_secret_key = EXCLUDED.lenco_secret_key,
                                           is_wholesale_supplier = COALESCE($18, store_settings.is_wholesale_supplier),
                                           delivery_fee = COALESCE($19, store_settings.delivery_fee),
                                           free_delivery_above = CASE WHEN $22 THEN $20 ELSE store_settings.free_delivery_above END,
                                           store_description = CASE WHEN $23 THEN $21 ELSE store_settings.store_description END
            RETURNING *;
        `;
        const values = [
            storeId,
            newSettings.name, newSettings.address, newSettings.phone, newSettings.email, newSettings.website,
            newSettings.taxRate, JSON.stringify(newSettings.currency), newSettings.receiptMessage, newSettings.lowStockThreshold,
            newSettings.skuPrefix, newSettings.enableStoreCredit, JSON.stringify(newSettings.paymentMethods), JSON.stringify(newSettings.supplierPaymentMethods),
            newSettings.isOnlineStoreEnabled ?? true,
            newSettings.lencoPublicKey,
            newSettings.lencoSecretKey,
            // undefined → null → COALESCE keeps the stored value, so settings
            // screens that don't know these fields can't silently reset them.
            (newSettings as any).isWholesaleSupplier === undefined ? null : (newSettings as any).isWholesaleSupplier === true,
            (newSettings as any).deliveryFee === undefined ? null : Math.max(0, Number((newSettings as any).deliveryFee) || 0),
            // Nullable fields need a separate "was provided" flag ($22/$23)
            // since NULL is itself a meaningful value ("no threshold" / blank).
            (newSettings as any).freeDeliveryAbove === undefined || (newSettings as any).freeDeliveryAbove === null || String((newSettings as any).freeDeliveryAbove).trim() === ''
                ? null : Math.max(0, Number((newSettings as any).freeDeliveryAbove) || 0),
            (newSettings as any).storeDescription === undefined ? null : String((newSettings as any).storeDescription).slice(0, 600),
            (newSettings as any).freeDeliveryAbove !== undefined,
            (newSettings as any).storeDescription !== undefined
        ];

        const result = await db.query(query, values);
        auditService.log(req.user!, 'Settings Updated', 'Store settings were updated.');
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error("Error updating settings:", error);
        res.status(500).json({ message: "Error updating settings" });
    }
};