import express from 'express';
import db from '../db_client';
import { auditService } from '../services/audit.service';
import { StoreSettings } from '../types';
import { toCamelCase } from '../utils/helpers';

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
                paymentMethods: [],
                supplierPaymentMethods: []
            };
            const insert = await db.query(
                `INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
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
                    JSON.stringify(defaults.supplierPaymentMethods)
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

export const updateSettings = async (req: express.Request, res: express.Response) => {
    const newSettings: StoreSettings = req.body;
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) {
            return res.status(400).json({ message: 'No store selected. Please select a store first.' });
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
            INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
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
                                           supplier_payment_methods = EXCLUDED.supplier_payment_methods
            RETURNING *;
        `;
        const values = [
            storeId,
            newSettings.name, newSettings.address, newSettings.phone, newSettings.email, newSettings.website,
            newSettings.taxRate, JSON.stringify(newSettings.currency), newSettings.receiptMessage, newSettings.lowStockThreshold,
            newSettings.skuPrefix, newSettings.enableStoreCredit, JSON.stringify(newSettings.paymentMethods), JSON.stringify(newSettings.supplierPaymentMethods)
        ];

        const result = await db.query(query, values);
        auditService.log(req.user!, 'Settings Updated', 'Store settings were updated.');
        res.status(200).json(toCamelCase(result.rows[0]));
    } catch (error) {
        console.error("Error updating settings:", error);
        res.status(500).json({ message: "Error updating settings" });
    }
};