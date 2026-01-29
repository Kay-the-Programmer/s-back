import db from '../db_client';
import { generateId } from '../utils/helpers';
import { StoreSettings, Account, Category } from '../types';
import { categoryHierarchy, initialAccountsData, BUSINESS_TYPES } from '../utils/initial-data';

export class StoreInitService {
    async initializeNewStore(storeId: string, storeName: string, businessTypes: string[] = [], phone?: string, address?: string) {
        console.log(`Initializing store: ${storeName} (${storeId}) with types: ${businessTypes.join(', ')}`);

        await this.seedSettings(storeId, storeName, phone, address);
        const accountsMap = await this.seedAccounts(storeId);
        await this.seedCategories(storeId, businessTypes);

        console.log(`✅ Store ${storeId} initialized successfully.`);
    }

    private async seedSettings(storeId: string, storeName: string, phone?: string, address?: string) {
        const paymentMethods = [
            { id: 'cash', name: 'CASH' },
            { id: 'airtel', name: 'AIRTEL' },
            { id: 'mtn', name: 'MTN' }
        ];

        const defaults = {
            name: storeName,
            address: address || '',
            phone: phone || '',
            email: '',
            website: '',
            taxRate: 0,
            currency: { symbol: 'K', code: 'ZMW', position: 'before' },
            receiptMessage: '',
            lowStockThreshold: 5,
            skuPrefix: 'SKU-',
            enableStoreCredit: false,
            paymentMethods: paymentMethods,
            supplierPaymentMethods: paymentMethods,
            isOnlineStoreEnabled: true
        };

        const query = `
            INSERT INTO store_settings (store_id, name, address, phone, email, website, tax_rate, currency, receipt_message, low_stock_threshold, sku_prefix, enable_store_credit, payment_methods, supplier_payment_methods, is_online_store_enabled)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
            ON CONFLICT (store_id) DO NOTHING;
        `;

        await db.query(query, [
            storeId, defaults.name, defaults.address, defaults.phone, defaults.email, defaults.website,
            defaults.taxRate, JSON.stringify(defaults.currency), defaults.receiptMessage, defaults.lowStockThreshold,
            defaults.skuPrefix, defaults.enableStoreCredit, JSON.stringify(defaults.paymentMethods), JSON.stringify(defaults.supplierPaymentMethods),
            defaults.isOnlineStoreEnabled
        ]);
    }

    private async seedAccounts(storeId: string) {
        const initialAccounts = initialAccountsData;
        const accountsMap = new Map<string, string>();
        for (const acc of initialAccounts) {
            const res = await db.query(
                'INSERT INTO accounts (id, name, number, type, sub_type, is_debit_normal, description, balance, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, 0, $8) ON CONFLICT (store_id, number) DO NOTHING RETURNING id, sub_type',
                [generateId('acc'), acc.name, acc.number, acc.type, acc.subType, acc.isDebitNormal, acc.description, storeId]
            );
            if (res.rows[0]) {
                accountsMap.set(res.rows[0].sub_type || acc.number, res.rows[0].id);
            }
        }
        return accountsMap;
    }

    private async seedCategories(storeId: string, businessTypes: string[]) {
        let categoriesData = categoryHierarchy;

        if (businessTypes && businessTypes.length > 0) {
            // Filter categories based on selected business types
            const allowedCategoryNames = new Set<string>();

            for (const typeId of businessTypes) {
                const bType = BUSINESS_TYPES.find(t => t.id === typeId);
                if (bType) {
                    bType.categories.forEach(c => allowedCategoryNames.add(c));
                }
            }

            // If "other" or no match found in types (shouldn't happen if validation works),
            // we might want a fallback. for now, if set is empty, we do NOT filter (seed all)
            // or we seed a default subset.
            // Let's assume if they picked types, they want ONLY those types.
            if (allowedCategoryNames.size > 0) {
                categoriesData = categoryHierarchy.filter(c => allowedCategoryNames.has(c.name));
            }
        }

        for (const cat of categoriesData) {
            await this.insertCategoryRecursive(cat, null, storeId);
        }
    }

    private async insertCategoryRecursive(cat: any, parentId: string | null, storeId: string) {
        const name = typeof cat === 'string' ? cat : cat.name;
        const id = generateId('cat');

        await db.query(
            'INSERT INTO categories (id, name, parent_id, attributes, store_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
            [id, name, parentId, '[]', storeId]
        );

        if (cat.children && Array.isArray(cat.children)) {
            for (const child of cat.children) {
                await this.insertCategoryRecursive(child, id, storeId);
            }
        }
    }
}

export const storeInitService = new StoreInitService();
