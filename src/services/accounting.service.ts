import { Account, Sale, Product, Category, JournalEntry, JournalEntryLine, Return, Payment, SupplierPayment, SupplierInvoice, StoreSettings, PurchaseOrder } from '../types';
import db from '../db_client';
import { generateId } from '../utils/helpers';

type DBClient = { query: (text: string, params?: any[]) => Promise<any> };

// Ensures core system accounts exist for the given store. Idempotent.
const ensureCoreAccounts = async (storeId: string, client?: DBClient) => {
    const dbClient = client || db;
    // Define the standard chart of accounts we rely on
    const accounts: Array<{ number: string; name: string; type: Account['type']; sub: Account['subType']; debit: boolean; desc: string }> = [
        { number: '1010', name: 'Cash on Hand', type: 'asset', sub: 'cash', debit: true, desc: 'Physical cash and cash equivalents in the register.' },
        { number: '1100', name: 'Accounts Receivable', type: 'asset', sub: 'accounts_receivable', debit: true, desc: 'Money owed to the business by customers.' },
        { number: '1200', name: 'Inventory', type: 'asset', sub: 'inventory', debit: true, desc: 'Value of all products available for sale.' },
        { number: '2010', name: 'Accounts Payable', type: 'liability', sub: 'accounts_payable', debit: false, desc: 'Money owed to suppliers for inventory.' },
        { number: '2150', name: 'Goods Received Not Invoiced', type: 'liability', sub: 'gr_ir', debit: false, desc: 'GR/IR clearing: stock received but not yet invoiced (or invoiced but not yet received). Nets to zero once both occur.' },
        { number: '2200', name: 'Sales Tax Payable', type: 'liability', sub: 'sales_tax_payable', debit: false, desc: 'Sales tax collected, to be remitted to the government.' },
        { number: '2300', name: 'Store Credit Payable', type: 'liability', sub: 'store_credit_payable', debit: false, desc: 'Total outstanding store credit owed to customers.' },
        { number: '3010', name: "Owner's Equity", type: 'equity', sub: undefined as any, debit: false, desc: 'Initial investment and retained earnings.' },
        { number: '3020', name: "Owner's Drawings", type: 'equity', sub: 'owner_drawings', debit: true, desc: 'Goods and cash withdrawn from the business for personal use.' },
        { number: '4010', name: 'Sales Revenue', type: 'revenue', sub: 'sales_revenue', debit: false, desc: 'Default account for revenue from sales.' },
        { number: '5010', name: 'Cost of Goods Sold', type: 'expense', sub: 'cogs', debit: true, desc: 'Default account for the cost of goods sold.' },
        { number: '6010', name: 'Rent Expense', type: 'expense', sub: undefined as any, debit: true, desc: 'Monthly rent for the store premises.' },
        { number: '6020', name: 'Inventory Adjustment Expense', type: 'expense', sub: 'inventory_adjustment', debit: true, desc: 'Expense from inventory shrinkage, damage, or adjustments.' }
    ];

    // Insert missing accounts for this store
    for (const a of accounts) {
        await dbClient.query(
            'INSERT INTO accounts (id, name, number, type, sub_type, is_debit_normal, description, balance, store_id) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8) ON CONFLICT (store_id, number) DO NOTHING',
            [generateId('acc'), a.name, a.number, a.type, a.sub ?? null, a.debit, a.desc, storeId]
        );
    }
};

const findAccount = async (subType: Account['subType'], storeId: string, client?: DBClient) => {
    const dbClient = client || db;
    const result = await dbClient.query('SELECT * FROM accounts WHERE sub_type = $1 AND store_id = $2', [subType, storeId]);
    if (result.rowCount === 0) {
        console.warn(`Accounting Warning: System account with subType '${subType}' not found for store ${storeId}.`);
        return null;
    }
    return result.rows[0] as Account;
};

const addJournalEntry = async (entry: Omit<JournalEntry, 'id'>, storeId: string, client?: DBClient) => {
    const dbClient = client || db;
    const entryId = generateId('je');

    // Double-entry integrity: refuse to post an unbalanced entry. Throwing here
    // aborts the surrounding DB transaction so the books never drift out of balance.
    const totalDebits = entry.lines.filter(l => l.type === 'debit').reduce((sum, l) => sum + l.amount, 0);
    const totalCredits = entry.lines.filter(l => l.type === 'credit').reduce((sum, l) => sum + l.amount, 0);
    if (Math.abs(totalDebits - totalCredits) > 0.01) {
        throw new Error(`Unbalanced journal entry ("${entry.description}"): debits ${totalDebits.toFixed(2)} ≠ credits ${totalCredits.toFixed(2)}.`);
    }

    await dbClient.query('INSERT INTO journal_entries (id, date, description, source_type, source_id, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
        [entryId, entry.date, entry.description, entry.source.type, entry.source.id, storeId]
    );

    for (const line of entry.lines) {
        await dbClient.query('INSERT INTO journal_entry_lines (journal_entry_id, account_id, type, amount, account_name, store_id) VALUES ($1, $2, $3, $4, $5, $6)',
            [entryId, line.accountId, line.type, line.amount, line.accountName, storeId]
        );
    }

    // Update account balances
    for (const line of entry.lines) {
        const accResult = await dbClient.query('SELECT is_debit_normal FROM accounts WHERE id = $1 AND store_id = $2', [line.accountId, storeId]);
        if (accResult.rowCount > 0) {
            const acc = accResult.rows[0];
            let change = line.amount;
            if ((acc.is_debit_normal && line.type === 'credit') || (!acc.is_debit_normal && line.type === 'debit')) {
                change = -change;
            }
            await dbClient.query('UPDATE accounts SET balance = balance + $1 WHERE id = $2 AND store_id = $3', [change, line.accountId, storeId]);
        }
    }
};

const recordSale = async (sale: Sale, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (sale as any).store_id;
    if (!storeId) {
        console.warn('recordSale: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const productIds = sale.cart.map(i => i.productId);
    if (productIds.length === 0) return;

    const allProductsResult = await dbClient.query('SELECT * FROM products WHERE id = ANY($1::text[]) AND store_id = $2', [productIds, storeId]);
    const allProducts: Product[] = allProductsResult.rows;

    const allCategoriesResult = await dbClient.query('SELECT * FROM categories WHERE store_id = $1', [storeId]);
    const allCategories: Category[] = allCategoriesResult.rows;

    const revenueByAccount = new Map<string, { account: Account, amount: number }>();
    const cogsByAccount = new Map<string, { account: Account, amount: number }>();

    const defaultRevenueAccount = await findAccount('sales_revenue', storeId, dbClient);
    const defaultCogsAccount = await findAccount('cogs', storeId, dbClient);
    const inventoryAccount = await findAccount('inventory', storeId, dbClient);
    const taxAccount = await findAccount('sales_tax_payable', storeId, dbClient);
    const cashAccount = await findAccount('cash', storeId, dbClient);
    const arAccount = await findAccount('accounts_receivable', storeId, dbClient);
    const storeCreditAccount = await findAccount('store_credit_payable', storeId, dbClient);

    if (!inventoryAccount || !taxAccount || !cashAccount || !defaultRevenueAccount || !defaultCogsAccount || !arAccount) {
        console.error("Accounting Error: Core accounts for sales are not configured for store", storeId);
        return;
    }

    const productMap = new Map(allProducts.map(p => [p.id, p]));
    const categoryMap = new Map(allCategories.map(c => [c.id, c]));

    const accountsMap = new Map<string, Account>();

    const totalCartValue = sale.cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
    const discountRatio = totalCartValue > 0 ? (sale.subtotal) / totalCartValue : 1;

    for (const item of sale.cart) {
        const product = productMap.get(item.productId);
        if (!product) continue;

        let revenueAccount = defaultRevenueAccount;
        if (product.categoryId) {
            const category = categoryMap.get(product.categoryId);
            if (category?.revenueAccountId) {
                if (!accountsMap.has(category.revenueAccountId)) {
                    const accountResult = await dbClient.query('SELECT * FROM accounts WHERE id = $1 AND store_id = $2', [category.revenueAccountId, storeId]);
                    if (accountResult.rowCount > 0) {
                        accountsMap.set(category.revenueAccountId, accountResult.rows[0]);
                    }
                }
                revenueAccount = accountsMap.get(category.revenueAccountId) || defaultRevenueAccount;
            }
        }
        const itemRevenue = (item.price * item.quantity) * discountRatio;
        const currentRevenue = revenueByAccount.get(revenueAccount.id) || { account: revenueAccount, amount: 0 };
        currentRevenue.amount += itemRevenue;
        revenueByAccount.set(revenueAccount.id, currentRevenue);

        let cogsAccount = defaultCogsAccount;
        if (product.categoryId) {
            const category = categoryMap.get(product.categoryId);
            if (category?.cogsAccountId) {
                if (!accountsMap.has(category.cogsAccountId)) {
                    const accountResult = await dbClient.query('SELECT * FROM accounts WHERE id = $1 AND store_id = $2', [category.cogsAccountId, storeId]);
                    if (accountResult.rowCount > 0) {
                        accountsMap.set(category.cogsAccountId, accountResult.rows[0]);
                    }
                }
                cogsAccount = accountsMap.get(category.cogsAccountId) || defaultCogsAccount;
            }
        }
        // Use the cost captured on the line at sale time so a void/return reverses
        // the exact COGS originally posted, and it matches sale_items.cost_at_sale.
        const itemCogs = ((item as any).costPrice ?? product.costPrice ?? 0) * item.quantity;
        const currentCogs = cogsByAccount.get(cogsAccount.id) || { account: cogsAccount, amount: 0 };
        currentCogs.amount += itemCogs;
        cogsByAccount.set(cogsAccount.id, currentCogs);
    }

    const totalCogs = Array.from(cogsByAccount.values()).reduce((sum, item) => sum + item.amount, 0);

    const amountPaid = Number(sale.amountPaid || 0);
    const storeCreditUsed = Number(sale.storeCreditUsed || 0);
    const balanceDue = Number(sale.total) - amountPaid - storeCreditUsed;

    const journalLines: JournalEntryLine[] = [
        { accountId: taxAccount.id, accountName: taxAccount.name, type: 'credit', amount: sale.tax },
        { accountId: inventoryAccount.id, accountName: inventoryAccount.name, type: 'credit', amount: totalCogs },
    ];

    if (amountPaid > 0) {
        if (sale.cashReceived && sale.changeDue && sale.cashReceived > 0) {
            // Explicitly record gross cash in and change out for better audit trail
            journalLines.push({ accountId: cashAccount.id, accountName: cashAccount.name, type: 'debit', amount: sale.cashReceived });
            journalLines.push({ accountId: cashAccount.id, accountName: cashAccount.name, type: 'credit', amount: sale.changeDue });
        } else {
            journalLines.push({ accountId: cashAccount.id, accountName: cashAccount.name, type: 'debit', amount: amountPaid });
        }
    }
    if (storeCreditUsed > 0 && storeCreditAccount) {
        journalLines.push({ accountId: storeCreditAccount.id, accountName: storeCreditAccount.name, type: 'debit', amount: storeCreditUsed });
    }
    if (balanceDue > 0.001) {
        journalLines.push({ accountId: arAccount.id, accountName: arAccount.name, type: 'debit', amount: balanceDue });
    }

    revenueByAccount.forEach(({ account, amount }) => {
        journalLines.push({ accountId: account.id, accountName: account.name, type: 'credit', amount: amount });
    });

    cogsByAccount.forEach(({ account, amount }) => {
        journalLines.push({ accountId: account.id, accountName: account.name, type: 'debit', amount: amount });
    });

    const customerName = sale.customerName || 'Walk-in Customer';
    let description = `Sale to ${customerName}`;
    if (sale.transactionId && sale.transactionId !== 'undefined') {
        description += ` - ID ${sale.transactionId}`;
    }

    await addJournalEntry({
        date: sale.timestamp,
        description: description,
        source: { type: 'sale', id: sale.transactionId },
        lines: journalLines.filter(line => line.amount > 0.001)
    }, storeId, dbClient);
};

const voidSale = async (sale: Sale, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (sale as any).storeId || (sale as any).store_id;
    if (!storeId) {
        console.warn('voidSale: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist
    await ensureCoreAccounts(storeId, dbClient);

    const productIds = sale.cart.map(i => i.productId);
    if (productIds.length === 0) return;

    const allProductsResult = await dbClient.query('SELECT * FROM products WHERE id = ANY($1::text[]) AND store_id = $2', [productIds, storeId]);
    const allProducts: Product[] = allProductsResult.rows;

    const allCategoriesResult = await dbClient.query('SELECT * FROM categories WHERE store_id = $1', [storeId]);
    const allCategories: Category[] = allCategoriesResult.rows;

    const revenueByAccount = new Map<string, { account: Account, amount: number }>();
    const cogsByAccount = new Map<string, { account: Account, amount: number }>();

    const defaultRevenueAccount = await findAccount('sales_revenue', storeId, dbClient);
    const defaultCogsAccount = await findAccount('cogs', storeId, dbClient);
    const inventoryAccount = await findAccount('inventory', storeId, dbClient);
    const taxAccount = await findAccount('sales_tax_payable', storeId, dbClient);
    const cashAccount = await findAccount('cash', storeId, dbClient);
    const arAccount = await findAccount('accounts_receivable', storeId, dbClient);
    const storeCreditAccount = await findAccount('store_credit_payable', storeId, dbClient);

    if (!inventoryAccount || !taxAccount || !cashAccount || !defaultRevenueAccount || !defaultCogsAccount || !arAccount) {
        console.error("Accounting Error: Core accounts for voiding sales are not configured for store", storeId);
        return;
    }

    const productMap = new Map(allProducts.map(p => [p.id, p]));
    const categoryMap = new Map(allCategories.map(c => [c.id, c]));

    const accountsMap = new Map<string, Account>();
    const totalCartValue = sale.cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
    const discountRatio = totalCartValue > 0 ? (sale.subtotal) / totalCartValue : 1;

    for (const item of sale.cart) {
        const product = productMap.get(item.productId);
        if (!product) continue;

        let revenueAccount = defaultRevenueAccount;
        if (product.categoryId) {
            const category = categoryMap.get(product.categoryId);
            if (category?.revenueAccountId) {
                if (!accountsMap.has(category.revenueAccountId)) {
                    const accountResult = await dbClient.query('SELECT * FROM accounts WHERE id = $1 AND store_id = $2', [category.revenueAccountId, storeId]);
                    if (accountResult.rowCount > 0) accountsMap.set(category.revenueAccountId, accountResult.rows[0]);
                }
                revenueAccount = accountsMap.get(category.revenueAccountId) || defaultRevenueAccount;
            }
        }
        const itemRevenue = (item.price * item.quantity) * discountRatio;
        const currentRevenue = revenueByAccount.get(revenueAccount.id) || { account: revenueAccount, amount: 0 };
        currentRevenue.amount += itemRevenue;
        revenueByAccount.set(revenueAccount.id, currentRevenue);

        let cogsAccount = defaultCogsAccount;
        if (product.categoryId) {
            const category = categoryMap.get(product.categoryId);
            if (category?.cogsAccountId) {
                if (!accountsMap.has(category.cogsAccountId)) {
                    const accountResult = await dbClient.query('SELECT * FROM accounts WHERE id = $1 AND store_id = $2', [category.cogsAccountId, storeId]);
                    if (accountResult.rowCount > 0) accountsMap.set(category.cogsAccountId, accountResult.rows[0]);
                }
                cogsAccount = accountsMap.get(category.cogsAccountId) || defaultCogsAccount;
            }
        }
        // Use the cost captured on the line at sale time so a void/return reverses
        // the exact COGS originally posted, and it matches sale_items.cost_at_sale.
        const itemCogs = ((item as any).costPrice ?? product.costPrice ?? 0) * item.quantity;
        const currentCogs = cogsByAccount.get(cogsAccount.id) || { account: cogsAccount, amount: 0 };
        currentCogs.amount += itemCogs;
        cogsByAccount.set(cogsAccount.id, currentCogs);
    }

    const totalCogs = Array.from(cogsByAccount.values()).reduce((sum, item) => sum + item.amount, 0);

    const amountPaid = Number(sale.amountPaid || 0);
    const storeCreditUsed = Number(sale.storeCreditUsed || 0);
    const balanceDue = Number(sale.total) - amountPaid - storeCreditUsed;

    // REVERSAL LINES (Swap Debit/Credit from recordSale)
    const journalLines: JournalEntryLine[] = [
        { accountId: taxAccount.id, accountName: taxAccount.name, type: 'debit', amount: sale.tax },
        { accountId: inventoryAccount.id, accountName: inventoryAccount.name, type: 'debit', amount: totalCogs },
    ];

    if (amountPaid > 0) {
        journalLines.push({ accountId: cashAccount.id, accountName: cashAccount.name, type: 'credit', amount: amountPaid });
    }
    if (storeCreditUsed > 0 && storeCreditAccount) {
        journalLines.push({ accountId: storeCreditAccount.id, accountName: storeCreditAccount.name, type: 'credit', amount: storeCreditUsed });
    }
    if (balanceDue > 0.001) {
        journalLines.push({ accountId: arAccount.id, accountName: arAccount.name, type: 'credit', amount: balanceDue });
    }

    revenueByAccount.forEach(({ account, amount }) => {
        journalLines.push({ accountId: account.id, accountName: account.name, type: 'debit', amount: amount });
    });

    cogsByAccount.forEach(({ account, amount }) => {
        journalLines.push({ accountId: account.id, accountName: account.name, type: 'credit', amount: amount });
    });

    await addJournalEntry({
        date: new Date().toISOString(),
        description: `VOID/CANCELLED Sale - ID ${sale.transactionId}`,
        source: { type: 'sale', id: sale.transactionId },
        lines: journalLines.filter(line => line.amount > 0.001)
    }, storeId, dbClient);
};

/**
 * Standard double-entry treatment per adjustment reason:
 *  - "Receiving Stock" (purchase outside the PO receive flow):
 *      Dr Inventory / Cr Goods Received Not Invoiced — capitalises the goods and
 *      parks the payable in GR/IR (same treatment as PO reception), instead of
 *      crediting an expense account, which misstated the P&L.
 *  - "Personal Use": Dr Owner's Drawings (equity) / Cr Inventory — withdrawals
 *      by the owner are not a business expense.
 *  - Everything else (Stock Count, Damaged Goods, Theft, Return, Other):
 *      shrinkage/write-off — losses Dr Inventory Adjustment Expense / Cr Inventory;
 *      found stock reverses (Dr Inventory / Cr the expense as a recovery).
 */
const offsetSubTypeForAdjustment = (reason: string): Account['subType'] => {
    if (reason === 'Receiving Stock') return 'gr_ir';
    if (reason === 'Personal Use') return 'owner_drawings';
    return 'inventory_adjustment';
};

const recordStockAdjustment = async (product: Product, oldQuantity: number, reason: string, client?: DBClient, storeIdParam?: string) => {
    const quantityChange = Number(product.stock) - Number(oldQuantity);
    if (quantityChange === 0) return;

    // Callers pass either a normalized Product (costPrice) or a raw DB row
    // (cost_price) — read both, otherwise the cost silently resolves to 0 and
    // the adjustment never reaches the books.
    const unitCost = Number((product as any).costPrice ?? (product as any).cost_price) || 0;
    const costOfChange = quantityChange * unitCost;
    if (Math.abs(costOfChange) < 0.01) return;

    const storeId = storeIdParam || (product as any).store_id;
    if (!storeId) {
        console.warn('recordStockAdjustment: Missing store_id; aborting journal entry.');
        return;
    }

    const dbClient = client || db;
    await ensureCoreAccounts(storeId, dbClient);

    const inventoryAccount = await findAccount('inventory', storeId, dbClient);
    const offsetAccount = await findAccount(offsetSubTypeForAdjustment(reason), storeId, dbClient)
        // Fall back to the generic adjustment account so the entry always posts balanced.
        || await findAccount('inventory_adjustment', storeId, dbClient);

    if (!inventoryAccount || !offsetAccount) {
        console.error('Accounting Error: Core accounts for stock adjustments are not configured for store', storeId);
        return;
    }

    const increase = costOfChange > 0;
    await addJournalEntry({
        date: new Date().toISOString(),
        description: `Inventory adjustment for ${product.name}. Reason: ${reason}.`,
        source: { type: 'manual' },
        lines: [
            {
                accountId: inventoryAccount.id,
                accountName: inventoryAccount.name,
                type: increase ? 'debit' : 'credit',
                amount: Math.abs(costOfChange)
            },
            {
                accountId: offsetAccount.id,
                accountName: offsetAccount.name,
                type: increase ? 'credit' : 'debit',
                amount: Math.abs(costOfChange)
            }
        ]
    }, storeId, dbClient);
};

const recordConsolidatedStockAdjustment = async (totalAdjustmentCost: number, description: string, client?: DBClient, storeId?: string) => {
    const dbClient = client || db;
    if (!storeId) {
        console.warn('recordConsolidatedStockAdjustment: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const inventoryAccount = await findAccount('inventory', storeId, dbClient);
    const adjustmentAccount = await findAccount('inventory_adjustment', storeId, dbClient);

    if (inventoryAccount && adjustmentAccount && Math.abs(totalAdjustmentCost) > 0.01) {
        await addJournalEntry({
            date: new Date().toISOString(),
            description: description,
            source: { type: 'manual' },
            lines: [
                {
                    accountId: inventoryAccount.id,
                    accountName: inventoryAccount.name,
                    type: totalAdjustmentCost > 0 ? 'debit' : 'credit',
                    amount: Math.abs(totalAdjustmentCost)
                },
                {
                    accountId: adjustmentAccount.id,
                    accountName: adjustmentAccount.name,
                    type: totalAdjustmentCost > 0 ? 'credit' : 'debit',
                    amount: Math.abs(totalAdjustmentCost)
                }
            ]
        }, storeId, dbClient);
    }
}

const recordReturn = async (returnInfo: Return, originalSale: Sale, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (returnInfo as any).store_id || (originalSale as any).store_id;
    if (!storeId) {
        console.warn('recordReturn: Missing store_id; aborting journal entry.');
        return;
    }

    await ensureCoreAccounts(storeId, dbClient);

    const productIds = returnInfo.returnedItems.map(i => i.productId);
    if (productIds.length === 0) return;

    const allProductsResult = await dbClient.query('SELECT * FROM products WHERE id = ANY($1::text[]) AND store_id = $2', [productIds, storeId]);
    const allProducts: Product[] = allProductsResult.rows;

    const allCategoriesResult = await dbClient.query('SELECT * FROM categories WHERE store_id = $1', [storeId]);
    const allCategories: Category[] = allCategoriesResult.rows;

    const revenueByAccount = new Map<string, { account: Account, amount: number }>();
    const cogsByAccount = new Map<string, { account: Account, amount: number }>();

    const defaultRevenueAccount = await findAccount('sales_revenue', storeId, dbClient);
    const defaultCogsAccount = await findAccount('cogs', storeId, dbClient);
    const inventoryAccount = await findAccount('inventory', storeId, dbClient);
    const taxAccount = await findAccount('sales_tax_payable', storeId, dbClient);
    const cashAccount = await findAccount('cash', storeId, dbClient);
    const arAccount = await findAccount('accounts_receivable', storeId, dbClient);
    const storeCreditAccount = await findAccount('store_credit_payable', storeId, dbClient);

    if (!inventoryAccount || !taxAccount || !cashAccount || !defaultRevenueAccount || !defaultCogsAccount || !arAccount) {
        console.error("Accounting Error: Core accounts for returns are not configured", storeId);
        return;
    }

    // Determine primary asset/liability for refund
    let refundAssetAccount = cashAccount;
    if (returnInfo.refundMethod === 'accounts_receivable' || returnInfo.refundMethod === 'on_account') {
        refundAssetAccount = arAccount;
    } else if (returnInfo.refundMethod === 'store_credit' && storeCreditAccount) {
        refundAssetAccount = storeCreditAccount;
    }

    const productMap = new Map(allProducts.map(p => [p.id, p]));
    const categoryMap = new Map(allCategories.map(c => [c.id, c]));
    const accountsMap = new Map<string, Account>();

    // Calculate original discount ratio to apply to returned items revenue
    const totalOriginalCartValue = originalSale.cart.reduce((acc, item: any) => acc + (item.priceAtSale || item.price || 0) * item.quantity, 0);
    const originalDiscountRatio = totalOriginalCartValue > 0 ? (originalSale.subtotal) / totalOriginalCartValue : 1;

    // Calculate total returned "nominal" value (before discount)
    const nominalReturnedItemsValue = returnInfo.returnedItems.reduce((acc, item) => {
        const saleItem = originalSale.cart.find(si => si.productId === item.productId);
        const price = saleItem ? ((saleItem as any).priceAtSale || (saleItem as any).price || 0) : (productMap.get(item.productId)?.price || 0);
        return acc + price * item.quantity;
    }, 0);

    const returnedTax = Number(returnInfo.taxAmount || 0);
    // Revenue reversed is the plug that keeps the entry balanced against the ACTUAL
    // cash/credit refunded: refund = revenue reversed + tax reversed ⇒ revenue = refund − tax.
    // This guarantees Σdebits == Σcredits even when a partial/custom refund is issued.
    const targetRevenueReduction = Math.max(0, Number(returnInfo.refundAmount || 0) - returnedTax);

    for (const item of returnInfo.returnedItems) {
        const product = productMap.get(item.productId);
        if (!product) continue;

        const saleItem = originalSale.cart.find(si => si.productId === item.productId);
        const price = saleItem ? ((saleItem as any).priceAtSale || (saleItem as any).price || 0) : (product.price || 0);

        // Calculate item's portion of the revenue reduction.
        // We use the nominal value * original discount ratio, but then we might need to adjust
        // if refundAmount differs from calculated value.
        // For simplicity and balance, we'll calculate the item's weight.
        const nominalItemValue = price * item.quantity;
        const weight = nominalReturnedItemsValue > 0 ? (nominalItemValue / nominalReturnedItemsValue) : (1 / returnInfo.returnedItems.length);

        // Amount to debit from this item's revenue account (share of the balanced total)
        const itemRevenueReduction = targetRevenueReduction * weight;

        let revenueAccount = defaultRevenueAccount;
        if (product.categoryId) {
            const category = categoryMap.get(product.categoryId);
            if (category?.revenueAccountId) {
                if (!accountsMap.has(category.revenueAccountId)) {
                    const accountResult = await dbClient.query('SELECT * FROM accounts WHERE id = $1 AND store_id = $2', [category.revenueAccountId, storeId]);
                    if (accountResult.rowCount > 0) accountsMap.set(category.revenueAccountId, accountResult.rows[0]);
                }
                revenueAccount = accountsMap.get(category.revenueAccountId) || defaultRevenueAccount;
            }
        }

        const currentRevenue = revenueByAccount.get(revenueAccount.id) || { account: revenueAccount, amount: 0 };
        currentRevenue.amount += itemRevenueReduction;
        revenueByAccount.set(revenueAccount.id, currentRevenue);

        if (item.addToStock) {
            let cogsAccount = defaultCogsAccount;
            if (product.categoryId) {
                const category = categoryMap.get(product.categoryId);
                if (category?.cogsAccountId) {
                    if (!accountsMap.has(category.cogsAccountId)) {
                        const accountResult = await dbClient.query('SELECT * FROM accounts WHERE id = $1 AND store_id = $2', [category.cogsAccountId, storeId]);
                        if (accountResult.rowCount > 0) accountsMap.set(category.cogsAccountId, accountResult.rows[0]);
                    }
                    cogsAccount = accountsMap.get(category.cogsAccountId) || defaultCogsAccount;
                }
            }
            // Use historical cost if available
            const cost = saleItem ? ((saleItem as any).costAtSale || (saleItem as any).costPrice || 0) : (product.costPrice || 0);
            const itemCogs = cost * item.quantity;
            const currentCogs = cogsByAccount.get(cogsAccount.id) || { account: cogsAccount, amount: 0 };
            currentCogs.amount += itemCogs;
            cogsByAccount.set(cogsAccount.id, currentCogs);
        }
    }

    const totalCogsReversed = Array.from(cogsByAccount.values()).reduce((sum, item) => sum + item.amount, 0);

    const journalLines: JournalEntryLine[] = [
        { accountId: refundAssetAccount.id, accountName: refundAssetAccount.name, type: 'credit', amount: returnInfo.refundAmount },
        { accountId: taxAccount.id, accountName: taxAccount.name, type: 'debit', amount: returnedTax },
    ];

    if (totalCogsReversed > 0) {
        journalLines.push({ accountId: inventoryAccount.id, accountName: inventoryAccount.name, type: 'debit', amount: totalCogsReversed });
    }

    revenueByAccount.forEach(({ account, amount }) => {
        // We use the calculated proportional revenue for each account
        // Note: the sum might slightly differ from returnedRevenueTotal due to rounding or manual refundAmount entry,
        // so we could proportionally adjust them to match returnedRevenueTotal exactly if needed.
        journalLines.push({ accountId: account.id, accountName: account.name, type: 'debit', amount: amount });
    });

    cogsByAccount.forEach(({ account, amount }) => {
        journalLines.push({ accountId: account.id, accountName: account.name, type: 'credit', amount: amount });
    });

    await addJournalEntry({
        date: returnInfo.timestamp,
        description: `Return for Sale ID ${originalSale.transactionId}`,
        source: { type: 'sale', id: returnInfo.id },
        lines: journalLines.filter(line => line.amount > 0.001)
    }, storeId, dbClient);

    // --- Trigger Email for Sales Return ---
    if (parseFloat(returnInfo.refundAmount.toString()) >= 100) {
        try {
            const { adminDb } = await import('../firebase');
            if (adminDb) {
                const storeRes = await db.query('SELECT owner_id FROM stores WHERE id = $1', [storeId]);
                if (storeRes.rowCount && storeRes.rows[0].owner_id) {
                    const ownerRes = await db.query('SELECT email, name FROM users WHERE id = $1', [storeRes.rows[0].owner_id]);
                    if (ownerRes.rowCount && ownerRes.rows[0].email) {
                        await adminDb.collection('mail_events').add({
                            type: 'SALES_RETURN_PROCESSED',
                            storeId,
                            userEmail: ownerRes.rows[0].email,
                            userName: ownerRes.rows[0].name,
                            refundAmount: returnInfo.refundAmount,
                            transactionId: originalSale.transactionId,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
        } catch (emailErr) {
            console.error('Email trigger failed for sales return:', emailErr);
        }
    }
    // --------------------------------------
};

const recordPurchaseOrderReception = async (poId: string, poNumber: string, receivedItems: { productId: string, quantity: number, costPrice: number }[], client?: DBClient, storeId?: string) => {
    const dbClient = client || db;
    if (!storeId) {
        console.warn('recordPurchaseOrderReception: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const inventoryAccount = await findAccount('inventory', storeId, dbClient);
    const grirAccount = await findAccount('gr_ir', storeId, dbClient);
    if (!inventoryAccount || !grirAccount) {
        console.error("Accounting Error: Core accounts for purchases are not configured.");
        return;
    }

    const totalCost = receivedItems.reduce((acc, item) => acc + item.costPrice * item.quantity, 0);

    if (totalCost > 0) {
        await addJournalEntry({
            date: new Date().toISOString(),
            description: `Received stock for PO ${poNumber}`,
            source: { type: 'purchase', id: poId },
            lines: [
                // Goods received: recognize inventory now; park the payable in GR/IR until
                // the supplier invoice moves it to Accounts Payable (prevents double-counting).
                { accountId: inventoryAccount.id, accountName: inventoryAccount.name, type: 'debit', amount: totalCost },
                { accountId: grirAccount.id, accountName: grirAccount.name, type: 'credit', amount: totalCost },
            ],
        }, storeId, dbClient);

        // --- Trigger Email for PO Reception ---
        try {
            const { adminDb } = await import('../firebase');
            if (adminDb) {
                const storeRes = await db.query('SELECT owner_id FROM stores WHERE id = $1', [storeId]);
                if (storeRes.rowCount && storeRes.rows[0].owner_id) {
                    const ownerRes = await db.query('SELECT email, name FROM users WHERE id = $1', [storeRes.rows[0].owner_id]);
                    if (ownerRes.rowCount && ownerRes.rows[0].email) {
                        await adminDb.collection('mail_events').add({
                            type: 'PO_RECEPTION_RECEIVED',
                            storeId,
                            userEmail: ownerRes.rows[0].email,
                            userName: ownerRes.rows[0].name,
                            poNumber: poNumber,
                            totalCost: totalCost,
                            itemCount: receivedItems.length,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
        } catch (emailErr) {
            console.error('Email trigger failed for PO reception:', emailErr);
        }
        // --------------------------------------
    }
};

const recordCustomerPayment = async (sale: Sale, payment: Payment, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (sale as any).store_id;
    if (!storeId) {
        console.warn('recordCustomerPayment: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const cashAccount = await findAccount('cash', storeId, dbClient);
    const arAccount = await findAccount('accounts_receivable', storeId, dbClient);
    const storeCreditAccount = await findAccount('store_credit_payable', storeId, dbClient);

    if (!cashAccount || !arAccount) {
        console.error("Accounting Error: Core accounts for payments are not configured.");
        return;
    }

    let debitAccount = cashAccount;
    if (payment.method === 'store_credit' && storeCreditAccount) {
        debitAccount = storeCreditAccount;
    }

    const invoiceRef = (sale.transactionId && sale.transactionId !== 'undefined')
        ? sale.transactionId
        : (sale.customerName || 'Walk-in Customer');

    let description = `Payment for Invoice ${invoiceRef}`;
    if (payment.reference) {
        description += ` (Ref: ${payment.reference})`;
    }

    await addJournalEntry({
        date: payment.date,
        description: description,
        source: { type: 'payment', id: sale.transactionId },
        lines: [
            { accountId: debitAccount.id, accountName: debitAccount.name, type: 'debit', amount: payment.amount },
            { accountId: arAccount.id, accountName: arAccount.name, type: 'credit', amount: payment.amount },
        ]
    }, storeId, dbClient);
};

const recordSupplierInvoice = async (invoice: SupplierInvoice, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (invoice as any).store_id;
    if (!storeId) {
        console.warn('recordSupplierInvoice: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const grirAccount = await findAccount('gr_ir', storeId, dbClient);
    const apAccount = await findAccount('accounts_payable', storeId, dbClient);
    if (!grirAccount || !apAccount) {
        console.error("Accounting Error: Core accounts for supplier invoices are not configured.");
        return;
    }

    await addJournalEntry({
        date: invoice.invoiceDate,
        description: `Supplier Invoice ${invoice.invoiceNumber} from ${invoice.supplierName}`,
        source: { type: 'purchase', id: invoice.id },
        lines: [
            // Invoice received: clear the GR/IR liability into Accounts Payable. The goods
            // themselves were already capitalised to Inventory at reception time.
            { accountId: grirAccount.id, accountName: grirAccount.name, type: 'debit', amount: invoice.amount },
            { accountId: apAccount.id, accountName: apAccount.name, type: 'credit', amount: invoice.amount },
        ]
    }, storeId, dbClient);
};

const reverseSupplierInvoice = async (invoice: SupplierInvoice, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (invoice as any).store_id;
    if (!storeId) {
        console.warn('reverseSupplierInvoice: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const grirAccount = await findAccount('gr_ir', storeId, dbClient);
    const apAccount = await findAccount('accounts_payable', storeId, dbClient);
    if (!grirAccount || !apAccount) {
        console.error("Accounting Error: Core accounts for reversing supplier invoices are not configured.");
        return;
    }

    await addJournalEntry({
        date: new Date().toISOString(),
        description: `REVERSAL: Supplier Invoice ${invoice.invoiceNumber} from ${invoice.supplierName}`,
        source: { type: 'purchase', id: invoice.id },
        lines: [
            { accountId: grirAccount.id, accountName: grirAccount.name, type: 'credit', amount: invoice.amount },
            { accountId: apAccount.id, accountName: apAccount.name, type: 'debit', amount: invoice.amount },
        ]
    }, storeId, dbClient);
};

const recordSupplierPayment = async (invoice: SupplierInvoice, payment: SupplierPayment, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (invoice as any).store_id;
    if (!storeId) {
        console.warn('recordSupplierPayment: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const cashAccount = await findAccount('cash', storeId, dbClient);
    const apAccount = await findAccount('accounts_payable', storeId, dbClient);
    if (!cashAccount || !apAccount) {
        console.error("Accounting Error: Core accounts for supplier payments are not configured.");
        return;
    }

    await addJournalEntry({
        date: payment.date,
        description: `Payment for supplier invoice ${invoice.invoiceNumber}`,
        source: { type: 'payment', id: invoice.id },
        lines: [
            { accountId: apAccount.id, accountName: apAccount.name, type: 'debit', amount: payment.amount },
            { accountId: cashAccount.id, accountName: cashAccount.name, type: 'credit', amount: payment.amount },
        ]
    }, storeId, dbClient);

    // --- Push Notification for Supplier Payment ---
    try {
        const { pushService } = await import('./push.service');
        await pushService.sendToStore(storeId, {
            title: 'Supplier Paid 💳',
            body: `Payment of ${payment.amount} made to ${invoice.supplierName} for Inv #${invoice.invoiceNumber}.`,
            url: `/accounting/suppliers`
        });
    } catch (pushErr) {
        console.error('Push failed for supplier payment:', pushErr);
    }

    // --- Trigger Email for Supplier Payment ---
    try {
        const { adminDb } = await import('../firebase');
        if (adminDb) {
            const storeRes = await db.query('SELECT owner_id FROM stores WHERE id = $1', [storeId]);
            if (storeRes.rowCount && storeRes.rows[0].owner_id) {
                const ownerRes = await db.query('SELECT email, name FROM users WHERE id = $1', [storeRes.rows[0].owner_id]);
                if (ownerRes.rowCount && ownerRes.rows[0].email) {
                    await adminDb.collection('mail_events').add({
                        type: 'SUPPLIER_PAYMENT_MADE',
                        storeId,
                        userEmail: ownerRes.rows[0].email,
                        userName: ownerRes.rows[0].name,
                        supplierName: invoice.supplierName,
                        amount: payment.amount,
                        invoiceNumber: invoice.invoiceNumber,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
    } catch (emailErr) {
        console.error('Email trigger failed for supplier payment:', emailErr);
    }
    // ------------------------------------------
};

const recordExpense = async (expense: any, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (expense as any).store_id;
    if (!storeId) {
        console.warn('recordExpense: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    // Create journal entry: Debit Expense Account, Credit Payment Account (Cash or AP)
    await addJournalEntry({
        date: expense.date,
        description: `Expense: ${expense.description}`,
        source: { type: 'manual', id: expense.id },
        lines: [
            {
                accountId: expense.expenseAccountId,
                accountName: expense.expenseAccountName,
                type: 'debit',
                amount: expense.amount
            },
            {
                accountId: expense.paymentAccountId,
                accountName: expense.paymentAccountName,
                type: 'credit',
                amount: expense.amount
            }
        ]
    }, storeId, dbClient);

    // --- Push Notification for Expense ---
    try {
        const { pushService } = await import('./push.service');
        await pushService.sendToStore(storeId, {
            title: 'New Expense Recorded 💸',
            body: `An expense of ${expense.amount} for "${expense.description}" has been recorded.`,
            url: `/accounting/expenses`
        }, ['admin', 'superadmin']);
    } catch (pushErr) {
        console.error('Push failed for expense record:', pushErr);
    }

    // --- Trigger Email for Large Expense ---
    if (parseFloat(expense.amount) >= 500) { // Threshold for "Important" notification
        try {
            const { adminDb } = await import('../firebase');
            if (adminDb) {
                const storeRes = await db.query('SELECT owner_id FROM stores WHERE id = $1', [storeId]);
                if (storeRes.rowCount && storeRes.rows[0].owner_id) {
                    const ownerRes = await db.query('SELECT email, name FROM users WHERE id = $1', [storeRes.rows[0].owner_id]);
                    if (ownerRes.rowCount && ownerRes.rows[0].email) {
                        await adminDb.collection('mail_events').add({
                            type: 'LARGE_EXPENSE_RECORDED',
                            storeId,
                            userEmail: ownerRes.rows[0].email,
                            userName: ownerRes.rows[0].name,
                            amount: expense.amount,
                            description: expense.description,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            }
        } catch (emailErr) {
            console.error('Email trigger failed for large expense:', emailErr);
        }
    }
    // ---------------------------------------
};

const reverseExpense = async (expense: any, client?: DBClient, storeIdParam?: string) => {
    const dbClient = client || db;
    const storeId = storeIdParam || (expense as any).store_id;
    if (!storeId) {
        console.warn('reverseExpense: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    // Reverse the journal entry: Credit Expense Account, Debit Payment Account
    await addJournalEntry({
        date: new Date().toISOString(),
        description: `Reversal: Expense ${expense.description}`,
        source: { type: 'manual', id: expense.id },
        lines: [
            {
                accountId: expense.expenseAccountId,
                accountName: expense.expenseAccountName,
                type: 'credit',
                amount: expense.amount
            },
            {
                accountId: expense.paymentAccountId,
                accountName: expense.paymentAccountName,
                type: 'debit',
                amount: expense.amount
            }
        ]
    }, storeId, dbClient);

    // --- Push Notification for Expense Reversal ---
    try {
        const { pushService } = await import('./push.service');
        await pushService.sendToStore(storeId, {
            title: 'Expense Reversed ⚠️',
            body: `The expense "${expense.description}" of ${expense.amount} has been reversed.`,
            url: `/accounting/expenses`
        }, ['admin', 'superadmin']);
    } catch (pushErr) {
        console.error('Push failed for expense reversal:', pushErr);
    }
};


export const accountingService = {
    addJournalEntry,
    recordSale,
    recordStockAdjustment,
    recordConsolidatedStockAdjustment,
    recordReturn,
    recordPurchaseOrderReception,
    recordSupplierInvoice,
    reverseSupplierInvoice,
    recordCustomerPayment,
    recordSupplierPayment,
    voidSale,
    recordExpense,
    reverseExpense,
    ensureSupplierInvoiceForPO: async (po: PurchaseOrder, client?: DBClient, storeIdParam?: string) => {
        const dbClient = client || db;
        const storeId = storeIdParam || (po as any).store_id;
        if (!storeId) return;

        // Check if invoice already exists
        const check = await dbClient.query('SELECT id FROM supplier_invoices WHERE purchase_order_id = $1 AND store_id = $2', [po.id, storeId]);
        if (check.rowCount > 0) return;

        const id = generateId('inv-sup');
        const invoiceNumber = `INV-${po.poNumber}`;
        const invoiceDate = po.orderedAt || new Date().toISOString().split('T')[0];
        // Default due date to 30 days if not set
        const dueDate = po.expectedAt || new Date(new Date().getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

        await dbClient.query(
            'INSERT INTO supplier_invoices (id, invoice_number, supplier_id, supplier_name, purchase_order_id, po_number, invoice_date, due_date, amount, amount_paid, status, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, \'unpaid\', $10)',
            [id, invoiceNumber, po.supplierId, po.supplierName, po.id, po.poNumber, invoiceDate, dueDate, po.total, storeId]
        );

        // Post the invoice to the GL (Dr GR/IR, Cr A/P) so the auto-created payable is
        // reflected in the ledger and reconciles with the A/P sub-ledger from day one.
        await recordSupplierInvoice(
            { id, invoiceNumber, supplierId: po.supplierId, supplierName: po.supplierName, purchaseOrderId: po.id, poNumber: po.poNumber, invoiceDate, dueDate, amount: po.total, amountPaid: 0, status: 'unpaid', payments: [] } as SupplierInvoice,
            dbClient,
            storeId,
        );
    }
};