import { Account, Sale, Product, Category, JournalEntry, JournalEntryLine, Return, Payment, SupplierPayment, SupplierInvoice, StoreSettings, PurchaseOrder } from '../types';
import db from '../db_client';
import { generateId } from '../utils/helpers';
import { notifyStoreOwner } from './email-template.service';

type DBClient = { query: (text: string, params?: any[]) => Promise<any> };

// Ensures core system accounts exist for the given store. Idempotent.
const ensureCoreAccounts = async (storeId: string, client?: DBClient) => {
    const dbClient = client || db;
    // Define the standard chart of accounts we rely on
    const accounts: Array<{ number: string; name: string; type: Account['type']; sub: Account['subType']; debit: boolean; desc: string }> = [
        { number: '1010', name: 'Cash on Hand', type: 'asset', sub: 'cash', debit: true, desc: 'Physical cash and cash equivalents in the register.' },
        // Money received other than notes and coins, kept apart so each balance
        // can be checked against its own statement (the drawer, the MoMo
        // statement, the bank statement).
        { number: '1020', name: 'Mobile Money', type: 'asset', sub: 'mobile_money', debit: true, desc: 'MTN, Airtel and other mobile-money takings and payments.' },
        { number: '1030', name: 'Bank', type: 'asset', sub: 'bank', debit: true, desc: 'Card payments and bank transfers.' },
        { number: '1100', name: 'Accounts Receivable', type: 'asset', sub: 'accounts_receivable', debit: true, desc: 'Money owed to the business by customers.' },
        { number: '1200', name: 'Inventory', type: 'asset', sub: 'inventory', debit: true, desc: 'Value of all products available for sale.' },
        // VAT paid to suppliers, claimed back against VAT collected on sales.
        { number: '1300', name: 'VAT Input (recoverable)', type: 'asset', sub: 'vat_input', debit: true, desc: 'VAT paid on purchases, deducted from VAT owed on sales.' },
        { number: '2010', name: 'Accounts Payable', type: 'liability', sub: 'accounts_payable', debit: false, desc: 'Money owed to suppliers for inventory.' },
        { number: '2150', name: 'Goods Received Not Invoiced', type: 'liability', sub: 'gr_ir', debit: false, desc: 'GR/IR clearing: stock received but not yet invoiced (or invoiced but not yet received). Nets to zero once both occur.' },
        { number: '2200', name: 'Sales Tax Payable', type: 'liability', sub: 'sales_tax_payable', debit: false, desc: 'Sales tax collected, to be remitted to the government.' },
        { number: '2300', name: 'Store Credit Payable', type: 'liability', sub: 'store_credit_payable', debit: false, desc: 'Total outstanding store credit owed to customers.' },
        { number: '3010', name: "Owner's Equity", type: 'equity', sub: 'owner_equity', debit: false, desc: 'Initial investment and retained earnings.' },
        { number: '3020', name: "Owner's Drawings", type: 'equity', sub: 'owner_drawings', debit: true, desc: 'Goods and cash withdrawn from the business for personal use.' },
        { number: '4010', name: 'Sales Revenue', type: 'revenue', sub: 'sales_revenue', debit: false, desc: 'Default account for revenue from sales.' },
        { number: '5010', name: 'Cost of Goods Sold', type: 'expense', sub: 'cogs', debit: true, desc: 'Default account for the cost of goods sold.' },
        { number: '5020', name: 'Freight & Purchase Costs', type: 'expense', sub: 'freight_in', debit: true, desc: 'Shipping and tax on supplier purchases (not capitalised into inventory).' },
        { number: '6010', name: 'Rent Expense', type: 'expense', sub: undefined as any, debit: true, desc: 'Monthly rent for the store premises.' },
        { number: '6020', name: 'Inventory Adjustment Expense', type: 'expense', sub: 'inventory_adjustment', debit: true, desc: 'Expense from inventory shrinkage, damage, or adjustments.' },
        // Everyday running costs. The expense form's category buttons each post
        // to one of these by number, so "Utilities" can never land in Rent or
        // Cost of Goods Sold just because no better account existed.
        // A deliberate change to what stock is worth (a cost price corrected on
        // a product that already had one). Its own line, so it is never hidden
        // inside stock write-offs.
        { number: '6025', name: 'Stock Revaluation', type: 'expense', sub: 'stock_revaluation', debit: true, desc: 'Change in stock value from correcting a product cost price.' },
        { number: '6030', name: 'Utilities', type: 'expense', sub: undefined as any, debit: true, desc: 'Electricity, water, internet and phone.' },
        { number: '6040', name: 'Salaries & Wages', type: 'expense', sub: undefined as any, debit: true, desc: 'Pay for staff and casual workers.' },
        { number: '6050', name: 'Transport & Fuel', type: 'expense', sub: undefined as any, debit: true, desc: 'Fuel, transport and delivery costs.' },
        { number: '6060', name: 'Marketing & Advertising', type: 'expense', sub: undefined as any, debit: true, desc: 'Adverts, flyers, promotions and signage.' },
        { number: '6070', name: 'Taxes & Licences', type: 'expense', sub: undefined as any, debit: true, desc: 'Council levies, trading licences and business taxes (not sales tax collected).' },
        { number: '6080', name: 'Shop Supplies', type: 'expense', sub: undefined as any, debit: true, desc: 'Bags, cleaning materials, stationery and small items used in the shop.' },
        { number: '6090', name: 'Other Expenses', type: 'expense', sub: undefined as any, debit: true, desc: 'Running costs that fit no other category.' },
    ];

    // Insert missing accounts for this store
    for (const a of accounts) {
        await dbClient.query(
            'INSERT INTO accounts (id, name, number, type, sub_type, is_debit_normal, description, balance, store_id) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8) ON CONFLICT (store_id, number) DO NOTHING',
            [generateId('acc'), a.name, a.number, a.type, a.sub ?? null, a.debit, a.desc, storeId]
        );
    }

    // Backfill: stores created before Owner's Equity carried a sub_type need it
    // tagged so 'Initial Stock' capitalisation can find the account by sub_type.
    await dbClient.query(
        "UPDATE accounts SET sub_type = 'owner_equity' WHERE store_id = $1 AND number = '3010' AND sub_type IS NULL",
        [storeId]
    );
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

/**
 * Which money account a payment method lands in. Notes and coins are Cash on
 * Hand; MTN / Airtel / any mobile money is Mobile Money; card and bank
 * transfer are Bank. Everything used to go to Cash on Hand, so the cash
 * figure could not be checked against the drawer, nor mobile money against
 * its statement. An unknown method stays in Cash, as before.
 */
export const moneySubTypeFor = (method?: string | null): 'cash' | 'mobile_money' | 'bank' => {
    const m = String(method || '').toLowerCase();
    if (/mtn|airtel|zamtel|mobile|momo|lenco|wallet/.test(m)) return 'mobile_money';
    if (/card|visa|master|bank|transfer|eft|swipe|debit|credit card/.test(m)) return 'bank';
    return 'cash';
};

/** The money account for a payment method (falls back to Cash on Hand). */
const moneyAccountFor = async (method: string | null | undefined, storeId: string, dbClient: DBClient): Promise<Account | null> =>
    (await findAccount(moneySubTypeFor(method), storeId, dbClient)) || (await findAccount('cash', storeId, dbClient));

/**
 * A sale's payments, grouped by the money account they belong in. Uses the
 * payments on the sale object when present, else reads them from the
 * payments table. Totals are scaled to `amountPaid` so the entry always
 * balances; with no payment rows the whole amount is cash.
 */
const moneyLinesForSale = async (sale: any, amountPaid: number, storeId: string, dbClient: DBClient) => {
    let pays: { amount: number; method: string }[] = Array.isArray(sale.payments) ? sale.payments : [];
    if (pays.length === 0 && sale.transactionId) {
        const r = await dbClient.query('SELECT amount, method FROM payments WHERE sale_id = $1 AND store_id = $2', [sale.transactionId, storeId]);
        pays = r.rows;
    }
    const groups = new Map<string, number>();
    const paidSum = pays.reduce((a, p) => a + (Number(p.amount) || 0), 0);
    if (paidSum <= 0) {
        groups.set('cash', amountPaid);
    } else {
        for (const p of pays) {
            const key = moneySubTypeFor(p.method);
            groups.set(key, (groups.get(key) || 0) + (Number(p.amount) || 0) * (amountPaid / paidSum));
        }
    }
    const out: { account: Account; amount: number; sub: string }[] = [];
    for (const [sub, amount] of groups) {
        const account = (await findAccount(sub as any, storeId, dbClient)) || (await findAccount('cash', storeId, dbClient));
        if (account && amount > 0.001) out.push({ account, amount: Math.round(amount * 100) / 100, sub });
    }
    // Rounding: make the lines add up to amountPaid exactly.
    const drift = Math.round((amountPaid - out.reduce((a, l) => a + l.amount, 0)) * 100) / 100;
    if (out.length && Math.abs(drift) >= 0.01) out[0].amount = Math.round((out[0].amount + drift) * 100) / 100;
    return out;
};

/** Thrown when a posting falls in a closed period. `status` lets controllers answer 409. */
export class BooksLockedError extends Error {
    status = 409;
    code = 'BOOKS_LOCKED';
    constructor(public lockedUntil: string) {
        super(`The books are closed up to ${lockedUntil}. Record this on a later date, or reopen the period in Books → Reports.`);
    }
}

/** The date the books are closed up to (YYYY-MM-DD), or null when open. */
export const booksLockedUntil = async (storeId: string, client?: DBClient): Promise<string | null> => {
    const r = await (client || db).query('SELECT books_locked_until FROM store_settings WHERE store_id = $1', [storeId]);
    const v = r.rows[0]?.books_locked_until;
    if (!v) return null;
    return typeof v === 'string' ? v.slice(0, 10) : new Date(v).toISOString().slice(0, 10);
};

/** Throw BooksLockedError when `date` is on or before the lock date. */
export const assertOpenPeriod = async (storeId: string, date: string | Date | undefined | null, client?: DBClient) => {
    const lock = await booksLockedUntil(storeId, client);
    if (!lock) return;
    const day = (date ? new Date(date) : new Date()).toISOString().slice(0, 10);
    if (day <= lock) throw new BooksLockedError(lock);
};

const addJournalEntry = async (entry: Omit<JournalEntry, 'id'>, storeId: string, client?: DBClient) => {
    const dbClient = client || db;
    const entryId = generateId('je');

    // Closed periods stay closed: every posting passes through here, so nothing
    // can land in a month whose figures have been finalised.
    await assertOpenPeriod(storeId, entry.date, dbClient);

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

    return entryId;
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

    // Revenue is recognised NET of order-level discounts (sales.subtotal is the
    // pre-discount cart value). Prorating (subtotal − discount) across the lines
    // keeps the entry balanced: Dr cash/AR (= total) equals Cr net revenue + tax.
    const totalCartValue = sale.cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
    const netRevenueBase = Number(sale.subtotal) - Number(sale.discount || 0);
    const discountRatio = totalCartValue > 0 ? netRevenueBase / totalCartValue : 1;

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

    // Online-order delivery fee is part of sale.total (debited to cash/AR
    // below) so it needs a matching credit line to keep the entry balanced.
    const deliveryFee = Number((sale as any).deliveryFee || 0);
    if (deliveryFee > 0.001) {
        journalLines.push({ accountId: defaultRevenueAccount.id, accountName: defaultRevenueAccount.name, type: 'credit', amount: deliveryFee });
    }

    if (amountPaid > 0) {
        // Each payment method to its own money account (cash / mobile money / bank).
        const moneyLines = await moneyLinesForSale(sale, amountPaid, storeId, dbClient);
        for (const ml of moneyLines) {
            if (ml.sub === 'cash' && moneyLines.length === 1 && sale.cashReceived && sale.changeDue && sale.cashReceived > 0) {
                // Explicitly record gross cash in and change out for better audit trail
                journalLines.push({ accountId: ml.account.id, accountName: ml.account.name, type: 'debit', amount: sale.cashReceived });
                journalLines.push({ accountId: ml.account.id, accountName: ml.account.name, type: 'credit', amount: sale.changeDue });
            } else {
                journalLines.push({ accountId: ml.account.id, accountName: ml.account.name, type: 'debit', amount: ml.amount });
            }
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
    // Mirror recordSale: reverse revenue NET of discounts so the reversal balances.
    const totalCartValue = sale.cart.reduce((acc, item) => acc + item.price * item.quantity, 0);
    const netRevenueBase = Number(sale.subtotal) - Number(sale.discount || 0);
    const discountRatio = totalCartValue > 0 ? netRevenueBase / totalCartValue : 1;

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

    // Mirror recordSale's delivery-fee credit so the reversal balances too.
    const voidDeliveryFee = Number((sale as any).deliveryFee || 0);
    if (voidDeliveryFee > 0.001) {
        journalLines.push({ accountId: defaultRevenueAccount.id, accountName: defaultRevenueAccount.name, type: 'debit', amount: voidDeliveryFee });
    }

    if (amountPaid > 0) {
        // Reverse each payment method from the money account it went into.
        for (const ml of await moneyLinesForSale(sale, amountPaid, storeId, dbClient)) {
            journalLines.push({ accountId: ml.account.id, accountName: ml.account.name, type: 'credit', amount: ml.amount });
        }
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
 *  - "Initial Stock" (opening inventory on product creation):
 *      Dr Inventory / Cr Owner's Equity — a capital contribution, NOT an expense
 *      recovery (crediting the adjustment expense overstated net income by the
 *      full opening stock value).
 *  - Everything else (Stock Count, Damaged Goods, Theft, Return, Other):
 *      shrinkage/write-off — losses Dr Inventory Adjustment Expense / Cr Inventory;
 *      found stock reverses (Dr Inventory / Cr the expense as a recovery).
 */
const offsetSubTypeForAdjustment = (reason: string): Account['subType'] => {
    if (reason === 'Receiving Stock') return 'gr_ir';
    if (reason === 'Personal Use') return 'owner_drawings';
    if (reason === 'Initial Stock') return 'owner_equity';
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

/**
 * Post a change in stock value against the right contra account:
 *   inventory_adjustment — counted gains/losses (stock takes, recounts);
 *   owner_equity         — opening stock brought into the business (imports);
 *   stock_revaluation    — a deliberate cost-price correction.
 */
const recordConsolidatedStockAdjustment = async (
    totalAdjustmentCost: number,
    description: string,
    client?: DBClient,
    storeId?: string,
    contraSubType: 'inventory_adjustment' | 'owner_equity' | 'stock_revaluation' = 'inventory_adjustment',
) => {
    const dbClient = client || db;
    if (!storeId) {
        console.warn('recordConsolidatedStockAdjustment: Missing store_id; aborting journal entry.');
        return;
    }

    // Ensure system accounts exist for this store
    await ensureCoreAccounts(storeId, dbClient);

    const inventoryAccount = await findAccount('inventory', storeId, dbClient);
    const adjustmentAccount = (await findAccount(contraSubType, storeId, dbClient)) || (await findAccount('inventory_adjustment', storeId, dbClient));

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
    // Money goes back out of the account it came in through: "original method"
    // uses the sale's first payment's method; a named method maps directly.
    let refundAssetAccount = cashAccount;
    if (returnInfo.refundMethod === 'original_method') {
        const firstPay = await dbClient.query('SELECT method FROM payments WHERE sale_id = $1 AND store_id = $2 ORDER BY date LIMIT 1', [originalSale.transactionId, storeId]);
        refundAssetAccount = (await moneyAccountFor(firstPay.rows[0]?.method, storeId, dbClient)) || cashAccount;
    } else if (returnInfo.refundMethod && !['accounts_receivable', 'on_account', 'store_credit'].includes(returnInfo.refundMethod)) {
        refundAssetAccount = (await moneyAccountFor(returnInfo.refundMethod, storeId, dbClient)) || cashAccount;
    }
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

    // --- Trigger Email for Sales Return (configurable engine) ---
    if (parseFloat(returnInfo.refundAmount.toString()) >= 100) {
        await notifyStoreOwner('SALES_RETURN_PROCESSED', storeId, {
            refundAmount: returnInfo.refundAmount,
            transactionId: originalSale.transactionId,
        });
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

        // --- Trigger Email for PO Reception (configurable engine) ---
        await notifyStoreOwner('PO_RECEPTION_RECEIVED', storeId, {
            poNumber,
            totalCost,
            itemCount: receivedItems.length,
        });
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

    let debitAccount = (await moneyAccountFor(payment.method, storeId, dbClient)) || cashAccount;
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

/**
 * Splits a supplier invoice into the goods portion (clears GR/IR, which was
 * credited at goods cost when stock was received) and the non-goods portion
 * (shipping + purchase tax → Freight & Purchase Costs). Without the split,
 * GR/IR was debited at the PO TOTAL and never netted to zero, and freight/tax
 * never reached the P&L. Invoices not linked to a PO are all goods.
 */
const round2Gl = (n: number) => Math.round(n * 100) / 100;

const splitInvoiceForGl = async (invoice: SupplierInvoice, storeId: string, dbClient: DBClient): Promise<{ goods: number; other: number; tax?: number }> => {
    const amount = Number(invoice.amount) || 0;
    // A purchase-order bill kept in step with deliveries records exactly what it
    // posted; use that, so a reversal cancels it to the cent.
    const postedGoods = (invoice as any).postedGoods ?? (invoice as any).posted_goods;
    const postedOther = (invoice as any).postedOther ?? (invoice as any).posted_other;
    if (postedGoods !== null && postedGoods !== undefined) {
        const postedTax = Number((invoice as any).postedTax ?? (invoice as any).posted_tax) || 0;
        return { goods: Number(postedGoods) || 0, other: round2Gl((Number(postedOther) || 0) - postedTax), tax: postedTax };
    }
    const poId = (invoice as any).purchaseOrderId || (invoice as any).purchase_order_id;
    if (poId) {
        const poRes = await dbClient.query('SELECT subtotal FROM purchase_orders WHERE id = $1 AND store_id = $2', [poId, storeId]);
        if (poRes.rowCount > 0) {
            const goods = Math.min(amount, Number(poRes.rows[0].subtotal) || 0);
            return { goods, other: Math.round((amount - goods) * 100) / 100 };
        }
    }
    return { goods: amount, other: 0 };
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
    const freightAccount = await findAccount('freight_in', storeId, dbClient);
    if (!grirAccount || !apAccount) {
        console.error("Accounting Error: Core accounts for supplier invoices are not configured.");
        return;
    }

    const { goods, other, tax = 0 } = freightAccount
        ? await splitInvoiceForGl(invoice, storeId, dbClient)
        : { goods: Number(invoice.amount) || 0, other: 0, tax: 0 };
    const vatInAcc = tax > 0 ? await findAccount('vat_input', storeId, dbClient) : null;

    const lines: JournalEntryLine[] = [
        // Invoice received: clear the GR/IR liability into Accounts Payable. The goods
        // themselves were already capitalised to Inventory at reception time.
        { accountId: grirAccount.id, accountName: grirAccount.name, type: 'debit', amount: goods },
        { accountId: apAccount.id, accountName: apAccount.name, type: 'credit', amount: invoice.amount },
    ];
    if (other > 0 && freightAccount) {
        lines.push({ accountId: freightAccount.id, accountName: freightAccount.name, type: 'debit', amount: other });
    }
    if (tax > 0 && vatInAcc) {
        lines.push({ accountId: vatInAcc.id, accountName: vatInAcc.name, type: 'debit', amount: tax });
    }

    await addJournalEntry({
        date: invoice.invoiceDate,
        description: `Supplier Invoice ${invoice.invoiceNumber} from ${invoice.supplierName}`,
        source: { type: 'purchase', id: invoice.id },
        lines,
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
    const freightAccount = await findAccount('freight_in', storeId, dbClient);
    if (!grirAccount || !apAccount) {
        console.error("Accounting Error: Core accounts for reversing supplier invoices are not configured.");
        return;
    }

    // Mirror recordSupplierInvoice's split so the reversal cancels it exactly.
    const { goods, other, tax = 0 } = freightAccount
        ? await splitInvoiceForGl(invoice, storeId, dbClient)
        : { goods: Number(invoice.amount) || 0, other: 0, tax: 0 };
    const vatInAcc = tax > 0 ? await findAccount('vat_input', storeId, dbClient) : null;

    const lines: JournalEntryLine[] = [
        { accountId: grirAccount.id, accountName: grirAccount.name, type: 'credit', amount: goods },
        { accountId: apAccount.id, accountName: apAccount.name, type: 'debit', amount: invoice.amount },
    ];
    if (other > 0 && freightAccount) {
        lines.push({ accountId: freightAccount.id, accountName: freightAccount.name, type: 'credit', amount: other });
    }
    if (tax > 0 && vatInAcc) {
        lines.push({ accountId: vatInAcc.id, accountName: vatInAcc.name, type: 'credit', amount: tax });
    }

    await addJournalEntry({
        date: new Date().toISOString(),
        description: `REVERSAL: Supplier Invoice ${invoice.invoiceNumber} from ${invoice.supplierName}`,
        source: { type: 'purchase', id: invoice.id },
        lines,
    }, storeId, dbClient);
};

export interface BillSyncResult {
    poNumber: string;
    action: 'none' | 'created' | 'adjusted' | 'removed' | 'skipped';
    /** Bill amount before and after (0 when there was / is no bill). */
    before: number;
    after: number;
    reason?: string;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Keep a purchase order's supplier bill equal to what has actually arrived.
 *
 * A bill used to be raised for the FULL order the moment it was placed, so
 * payables showed money owed for goods still on the road, or never coming,
 * since cancelling an order left its bill behind. Now the bill is the value
 * received: goods at order cost, plus that share of the order's tax and
 * delivery (all of it once everything is in). Run after every change to an
 * order (create, edit, cancel, receive), it posts only the difference from
 * what the bill has already put through the ledger:
 *     Dr GR/IR (goods) + Dr Freight & Purchase Costs (tax/delivery) / Cr A/P
 * and the reverse when it goes down. Money already paid is never un-billed.
 * A bill that falls to nothing, with nothing paid, is removed.
 */
const syncSupplierBillForPO = async (
    poId: string,
    storeId: string,
    client?: DBClient,
    opts: { dryRun?: boolean } = {},
): Promise<BillSyncResult> => {
    const dbClient = client || db;
    const poRes = await dbClient.query(
        'SELECT id, po_number, supplier_id, supplier_name, status, subtotal, total, tax FROM purchase_orders WHERE id = $1 AND store_id = $2',
        [poId, storeId],
    );
    if (!poRes.rowCount) return { poNumber: poId, action: 'skipped', before: 0, after: 0, reason: 'order not found' };
    const po = poRes.rows[0];
    const items = (await dbClient.query(
        'SELECT quantity, received_quantity, cost_price FROM purchase_order_items WHERE po_id = $1 AND store_id = $2',
        [poId, storeId],
    )).rows;

    const subtotal = Number(po.subtotal) || 0;
    const total = Number(po.total) || 0;
    // Never bill beyond what was ordered: a line showing more received than
    // ordered is a double-booked receipt (the bug fixed on 2026-11-16), not a
    // bigger delivery. scripts/reconcile_po_bills reports those for a recount.
    const receivedGoods = round2(items.reduce((s: number, i: any) =>
        s + Math.min(Number(i.received_quantity) || 0, Number(i.quantity) || 0) * (Number(i.cost_price) || 0), 0));
    const allReceived = items.length > 0
        && items.every((i: any) => (Number(i.received_quantity) || 0) >= (Number(i.quantity) || 0) - 0.0001);
    const extras = Math.max(0, round2(total - subtotal));
    const targetOther = receivedGoods <= 0 ? 0
        : allReceived ? extras
            : subtotal > 0 ? round2(extras * receivedGoods / subtotal) : 0;
    let targetGoods = receivedGoods;

    // VAT on the bill is claimed back (VAT Input) when the store itself charges
    // VAT; the rest of the extras (delivery) is a purchase cost (Freight). It
    // used to all be expensed, so VAT paid on stock was never recovered.
    const settingsRow = await dbClient.query('SELECT tax_rate FROM store_settings WHERE store_id = $1', [storeId]);
    const vatRegistered = (Number(settingsRow.rows[0]?.tax_rate) || 0) > 0;
    const poTax = Math.min(extras, Math.max(0, Number(po.tax) || 0));
    const targetTax = !vatRegistered || receivedGoods <= 0 ? 0
        : allReceived ? round2(poTax)
            : subtotal > 0 ? round2(poTax * receivedGoods / subtotal) : 0;

    const invRes = await dbClient.query(
        'SELECT * FROM supplier_invoices WHERE purchase_order_id = $1 AND store_id = $2 ORDER BY created_at LIMIT 1 FOR UPDATE',
        [poId, storeId],
    );
    const inv = invRes.rows[0];
    const before = inv ? Number(inv.amount) || 0 : 0;

    if (!inv && !po.supplier_id) {
        return { poNumber: po.po_number, action: 'skipped', before: 0, after: 0, reason: 'no supplier named yet' };
    }

    const paid = inv ? Number(inv.amount_paid) || 0 : 0;
    if (targetGoods + targetOther < paid) targetGoods = round2(paid - targetOther);
    const after = round2(targetGoods + targetOther);

    // What the bill has posted so far. Bills from before this change posted the
    // whole amount with the old rule: goods up to the order subtotal, the rest
    // to freight.
    let oldGoods = 0;
    let oldOther = 0;
    // VAT part of what was posted (inside posted_other); none on older bills.
    const oldTax = inv && inv.posted_tax !== null && inv.posted_tax !== undefined ? Number(inv.posted_tax) || 0 : 0;
    if (inv) {
        if (inv.posted_goods !== null && inv.posted_goods !== undefined) {
            oldGoods = Number(inv.posted_goods) || 0;
            oldOther = Number(inv.posted_other) || 0;
        } else {
            oldGoods = Math.min(before, subtotal);
            oldOther = round2(before - oldGoods);
        }
    }

    const dGoods = round2(targetGoods - oldGoods);
    const dOther = round2(targetOther - oldOther);
    const dTax = round2(targetTax - oldTax);
    const dFreight = round2(dOther - dTax);

    if (Math.abs(dGoods) < 0.005 && Math.abs(dOther) < 0.005 && Math.abs(dTax) < 0.005) {
        if (inv && (inv.posted_goods === null || inv.posted_goods === undefined) && !opts.dryRun) {
            await dbClient.query('UPDATE supplier_invoices SET posted_goods = $1, posted_other = $2, posted_tax = $3 WHERE id = $4 AND store_id = $5',
                [oldGoods, oldOther, oldTax, inv.id, storeId]);
        }
        return { poNumber: po.po_number, action: 'none', before, after: before };
    }

    const action: BillSyncResult['action'] = !inv ? 'created' : (after <= 0.005 && paid <= 0.005 ? 'removed' : 'adjusted');
    if (opts.dryRun) return { poNumber: po.po_number, action, before, after };

    await ensureCoreAccounts(storeId, dbClient);
    const grir = await findAccount('gr_ir', storeId, dbClient);
    const ap = await findAccount('accounts_payable', storeId, dbClient);
    const freight = await findAccount('freight_in', storeId, dbClient);
    const vatIn = await findAccount('vat_input', storeId, dbClient);
    if (!grir || !ap) throw new Error('Accounting Error: GR/IR or Accounts Payable is not configured for this store.');

    const invoiceId = inv?.id || generateId('inv-sup');
    const invoiceNumber = inv?.invoice_number || `INV-${po.po_number}`;
    const supplierName = po.supplier_name || inv?.supplier_name || 'Supplier';

    // Signed amounts to journal sides. With no freight account the extras ride on GR/IR.
    // VAT goes to VAT Input; with no VAT account it rides with freight.
    const vatSide = vatIn ? dTax : 0;
    const freightPart = vatIn ? dFreight : dOther;
    const goodsSide = freight ? dGoods : round2(dGoods + freightPart);
    const otherSide = freight ? freightPart : 0;
    const dTotal = round2(dGoods + dOther);
    const lines: JournalEntryLine[] = [];
    const push = (acc: Account, signedDebit: number) => {
        if (Math.abs(signedDebit) < 0.005) return;
        lines.push({ accountId: acc.id, accountName: acc.name, type: signedDebit > 0 ? 'debit' : 'credit', amount: Math.abs(signedDebit) });
    };
    push(grir, goodsSide);
    if (freight) push(freight, otherSide);
    if (vatIn) push(vatIn, vatSide);
    push(ap, -dTotal);

    if (lines.length > 0) {
        await addJournalEntry({
            date: new Date().toISOString(),
            description: !inv
                ? `Supplier Invoice ${invoiceNumber} from ${supplierName}`
                : `Supplier Invoice ${invoiceNumber} adjusted to goods received (${before.toFixed(2)} -> ${after.toFixed(2)})`,
            source: { type: 'purchase', id: invoiceId },
            lines,
        }, storeId, dbClient);
    }

    if (!inv) {
        const today = new Date();
        const due = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000);
        await dbClient.query(
            `INSERT INTO supplier_invoices (id, invoice_number, supplier_id, supplier_name, purchase_order_id, po_number, invoice_date, due_date, amount, amount_paid, status, store_id, posted_goods, posted_other, posted_tax)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, 'unpaid', $10, $11, $12, $13)`,
            [invoiceId, invoiceNumber, po.supplier_id, supplierName, po.id, po.po_number,
                today.toISOString().split('T')[0], due.toISOString().split('T')[0], after, storeId, targetGoods, targetOther, targetTax],
        );
    } else if (action === 'removed') {
        await dbClient.query('DELETE FROM supplier_invoices WHERE id = $1 AND store_id = $2', [inv.id, storeId]);
    } else {
        const status = paid >= after - 0.005 && after > 0 ? 'paid' : paid > 0.005 ? 'partially_paid' : 'unpaid';
        await dbClient.query(
            `UPDATE supplier_invoices SET amount = $1, posted_goods = $2, posted_other = $3, status = $4,
                    supplier_id = COALESCE($5, supplier_id), supplier_name = $6, posted_tax = $9
             WHERE id = $7 AND store_id = $8`,
            [after, targetGoods, targetOther, status, po.supplier_id, supplierName, inv.id, storeId, targetTax],
        );
    }

    return { poNumber: po.po_number, action, before, after };
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

    // Paid out of the account the method belongs to (cash / mobile money / bank).
    const paidFrom = (await moneyAccountFor(payment.method, storeId, dbClient)) || cashAccount;
    await addJournalEntry({
        date: payment.date,
        description: `Payment for supplier invoice ${invoice.invoiceNumber}`,
        source: { type: 'payment', id: invoice.id },
        lines: [
            { accountId: apAccount.id, accountName: apAccount.name, type: 'debit', amount: payment.amount },
            { accountId: paidFrom.id, accountName: paidFrom.name, type: 'credit', amount: payment.amount },
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

    // --- Trigger Email for Supplier Payment (configurable engine) ---
    await notifyStoreOwner('SUPPLIER_PAYMENT_MADE', storeId, {
        supplierName: invoice.supplierName,
        amount: payment.amount,
        invoiceNumber: invoice.invoiceNumber,
    });
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

    // --- Trigger Email for Large Expense (configurable engine) ---
    // The "large" threshold is now the template's editable `minAmount` condition,
    // so the engine decides whether to send — no hardcoded 500 here.
    await notifyStoreOwner('LARGE_EXPENSE_RECORDED', storeId, {
        amount: expense.amount,
        description: expense.description,
    });
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
    ensureCoreAccounts,
    booksLockedUntil,
    assertOpenPeriod,
    addJournalEntry,
    recordSale,
    recordStockAdjustment,
    recordConsolidatedStockAdjustment,
    recordReturn,
    recordPurchaseOrderReception,
    recordSupplierInvoice,
    reverseSupplierInvoice,
    syncSupplierBillForPO: (poId: string, storeId: string, client?: DBClient, opts?: { dryRun?: boolean }) =>
        syncSupplierBillForPO(poId, storeId, client, opts),
    recordCustomerPayment,
    recordSupplierPayment,
    voidSale,
    recordExpense,
    reverseExpense
};