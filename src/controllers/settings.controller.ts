import express from 'express';
import db from '../db_client';
import { auditService } from '../services/audit.service';
import { StoreSettings } from '../types';
import { toCamelCase } from '../utils/helpers';
import { isModuleEnabled, MODULES } from '../services/entitlements.service';
import { resolveSenderIdRequest, sanitizeDisplayName } from '../services/sms-branding';

export const getSettings = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = (req as any).tenant?.storeId;
        if (!storeId) {
            return res.status(400).json({ message: 'No store selected. Please select a store first.' });
        }

        // business_types lives on `stores`, not here, but the client needs it
        // beside the settings: it is what decides whether a venue's bills are
        // called tabs, tables or orders, and the settings object is the one
        // store-shaped thing every screen already has.
        const result = await db.query(
            `SELECT s.*, (SELECT st.business_types FROM stores st WHERE st.id = s.store_id) AS business_types
               FROM store_settings s WHERE s.store_id = $1`,
            [storeId],
        );
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
                `INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods, lenco_public_key, lenco_secret_key, sms_display_name)
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
                    defaults.lencoPublicKey,
                    defaults.lencoSecretKey,
                    // So a store's very first SMS already says who it is from,
                    // rather than waiting for the next server boot to backfill.
                    registeredStoreName.trim().slice(0, 20) || 'Store'
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

        /**
         * Bank accounts printed on invoices.
         *
         * Normalised here rather than trusted from the client: only the known
         * fields survive, each is length-capped, and the list is capped too, so
         * a settings save can't turn the column into an arbitrary blob. Returns
         * null when the caller didn't send the field at all, which the COALESCE
         * below reads as "leave the stored accounts alone" — an older settings
         * screen must not be able to wipe them.
         */
        const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
        const rawAccounts = (newSettings as any).bankAccounts;
        const bankAccounts = rawAccounts === undefined ? null : JSON.stringify(
            (Array.isArray(rawAccounts) ? rawAccounts : [])
                .filter((a: any) => a && typeof a === 'object')
                .slice(0, 10)
                .map((a: any, i: number) => ({
                    id: text(a.id, 60) || `bank_${Date.now()}_${i}`,
                    bankName: text(a.bankName, 80),
                    swiftCode: text(a.swiftCode, 20),
                    bankAddress: text(a.bankAddress, 160),
                    accountName: text(a.accountName, 80),
                    accountNumber: text(a.accountNumber, 40),
                    // `branch` is what the first cut of this feature stored;
                    // accept it so accounts saved then keep their branch.
                    branchName: text(a.branchName ?? a.branch, 80),
                    branchSortCode: text(a.branchSortCode, 20),
                    showOnInvoices: a.showOnInvoices !== false,
                }))
                // A row with no bank and no number is an empty form the operator
                // never filled in; storing it would print a blank line on invoices.
                .filter((a: any) => a.bankName || a.accountNumber)
        );

        /**
         * Who a customer sees an SMS from.
         *
         * The display name is prepended to every outgoing message server-side,
         * so it is sanitized and capped here rather than trusted. The sender id
         * is a different matter: it has to be registered with the networks, and
         * the string alone cannot tell us whether this shop is entitled to it —
         * a store's save only ever fills the pending column, and a superadmin
         * moves it across (see resolveSenderIdRequest).
         */
        const smsDisplayName = (newSettings as any).smsDisplayName === undefined
            ? null
            : (sanitizeDisplayName((newSettings as any).smsDisplayName) || null);

        let senderDecision: ReturnType<typeof resolveSenderIdRequest> | null = null;
        if ((newSettings as any).smsSenderId !== undefined || (newSettings as any).smsSenderIdRequested !== undefined) {
            const cur = await db.query(
                'SELECT sms_sender_id, sms_sender_id_requested, sms_sender_id_status FROM store_settings WHERE store_id = $1',
                [storeId],
            );
            const row = cur.rows[0] || {};
            senderDecision = resolveSenderIdRequest({
                currentSenderId: row.sms_sender_id,
                currentRequested: row.sms_sender_id_requested,
                currentStatus: row.sms_sender_id_status,
                // Either field name is read as "this is what we would like"; only
                // the superadmin route can approve one.
                requested: (newSettings as any).smsSenderIdRequested !== undefined
                    ? (newSettings as any).smsSenderIdRequested
                    : (newSettings as any).smsSenderId,
                isSuperAdmin: req.user?.role === 'superadmin',
            });
            if (!senderDecision.changed) senderDecision = null;
        }

        const query = `
            INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods, lenco_public_key, lenco_secret_key, tpin, business_tagline, bank_accounts, prices_include_tax, override_thresholds, sms_display_name, sms_sender_id, sms_sender_id_requested, sms_sender_id_status, business_mode)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, COALESCE($19::jsonb, '[]'::jsonb), COALESCE($20, FALSE), $21::jsonb, $22, $24, $25, COALESCE($26, 'none'), COALESCE($27, 'retail'))
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
                                           lenco_public_key = EXCLUDED.lenco_public_key,
                                           lenco_secret_key = EXCLUDED.lenco_secret_key,
                                           -- Undefined (a settings screen that doesn't know the field)
                                           -- must leave the stored value alone, not blank it.
                                           tpin = COALESCE($17, store_settings.tpin),
                                           business_tagline = COALESCE($18, store_settings.business_tagline),
                                           bank_accounts = COALESCE($19::jsonb, store_settings.bank_accounts),
                                           -- Whether shelf prices already contain tax. Undefined
                                           -- leaves it alone: a settings screen that predates the
                                           -- field must not silently change what a store charges.
                                           prices_include_tax = COALESCE($20, store_settings.prices_include_tax),
                                           -- Retail till, or menu + open bills. Undefined leaves it
                                           -- alone: a settings screen that predates the field must
                                           -- not knock a restaurant back to a retail till.
                                           business_mode = COALESCE($27, store_settings.business_mode),
                                           -- When a manager must be asked. Undefined leaves the
                                           -- stored limits alone; a settings screen that does not
                                           -- know the field must not quietly switch the control off.
                                           override_thresholds = COALESCE($21::jsonb, store_settings.override_thresholds),
                                           -- Undefined leaves the stored name alone; a settings
                                           -- screen that predates the field must not blank the
                                           -- only thing identifying the shop in a text.
                                           sms_display_name = COALESCE($22, store_settings.sms_display_name),
                                           -- $23 is the "the sender id changed" flag. Without it a
                                           -- save would have no way to clear an approved id, since
                                           -- NULL is itself a meaningful value here.
                                           sms_sender_id = CASE WHEN $23 THEN $24 ELSE store_settings.sms_sender_id END,
                                           sms_sender_id_requested = CASE WHEN $23 THEN $25 ELSE store_settings.sms_sender_id_requested END,
                                           sms_sender_id_status = CASE WHEN $23 THEN COALESCE($26, 'none') ELSE store_settings.sms_sender_id_status END
            RETURNING *;
        `;
        const values = [
            storeId,
            newSettings.name, newSettings.address, newSettings.phone, newSettings.email, newSettings.website,
            newSettings.taxRate, JSON.stringify(newSettings.currency), newSettings.receiptMessage, newSettings.lowStockThreshold,
            newSettings.skuPrefix, newSettings.enableStoreCredit, JSON.stringify(newSettings.paymentMethods), JSON.stringify(newSettings.supplierPaymentMethods),
            newSettings.lencoPublicKey,
            newSettings.lencoSecretKey,
            // TPIN + trading line, printed on receipts, delivery notes,
            // quotations and invoices.
            (newSettings as any).tpin === undefined ? null : String((newSettings as any).tpin).trim().slice(0, 40),
            (newSettings as any).businessTagline === undefined ? null : String((newSettings as any).businessTagline).trim().slice(0, 120),
            // Bank details for invoices; null = caller didn't send the field.
            bankAccounts,
            (newSettings as any).pricesIncludeTax === undefined
                ? null
                : (newSettings as any).pricesIncludeTax === true,
            (newSettings as any).overrideThresholds === undefined
                ? null
                : JSON.stringify((newSettings as any).overrideThresholds ?? {}),
            // SMS identity. The sender id trio is written only when
            // resolveSenderIdRequest decided something actually changed.
            smsDisplayName,
            senderDecision !== null,
            senderDecision?.senderId ?? null,
            senderDecision?.requestedSenderId ?? null,
            senderDecision?.status ?? null,
            // Which till this store runs. Only the two known values are
            // accepted; anything else is treated as "not sent" rather than
            // written through to a CHECK violation.
            ((newSettings as any).businessMode === 'retail' || (newSettings as any).businessMode === 'hospitality')
                ? (newSettings as any).businessMode
                : null,
        ];

        const result = await db.query(query, values);
        // Carried back with the saved settings, as on the read: the client uses
        // it for the venue's own wording and would otherwise lose it on a save.
        const types = await db.query('SELECT business_types FROM stores WHERE id = $1', [storeId]);
        auditService.log(req.user!, 'Settings Updated', 'Store settings were updated.');
        res.status(200).json(toCamelCase({
            ...result.rows[0],
            business_types: types.rows[0]?.business_types ?? [],
        }));
    } catch (error) {
        console.error("Error updating settings:", error);
        res.status(500).json({ message: "Error updating settings" });
    }
};