import express from 'express';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';

export const getDashboardData = async (req: express.Request, res: express.Response) => {
    const { startDate, endDate, channel } = req.query as { startDate: string, endDate: string, channel?: string };
    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'startDate and endDate query parameters are required.' });
    }

    const adjustedEndDate = new Date(new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();


    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        // --- Sales Calculations ---
        // Basis: ACCRUAL, matching the general ledger and /accounting/summary —
        // revenue is recognised when the sale occurs (all non-cancelled sales),
        // NET of order-level discounts and excluding sales tax. Cancelled sales
        // are excluded because their GL postings are voided and stock restored.
        const saleFilter = `s.fulfillment_status IS DISTINCT FROM 'cancelled'`;
        // Base params for period queries; the optional channel filter is appended
        // as a bound parameter ($4) — never interpolated (SQL injection).
        const periodParams: any[] = [startDate, adjustedEndDate, storeId];
        const channelParams = channel ? [...periodParams, channel] : periodParams;
        const channelClause = (alias: string) => channel ? `AND ${alias}.channel = $4 ` : '';

        // 1. Gross Sales & Transactions (Directly from sales table to avoid join duplication)
        const grossSalesQuery = `
            SELECT
                COALESCE(SUM(s.subtotal - COALESCE(s.discount, 0)), 0) AS "grossRevenue",
                COUNT(s.transaction_id) AS "totalTransactions"
            FROM sales s
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND s.store_id = $3
            ${channelClause('s')};
        `;
        const grossSalesResult = await db.query(grossSalesQuery, channelParams);

        // 2. COGS — matching principle: sales in the period carry their FULL cost
        // (dated by sale), and returns-to-stock reverse cost in the period the
        // RETURN happened (dated by return). Netting returned_quantity against the
        // sale period rewrote history: a March report changed when an April return
        // arrived, and no cost relief ever showed in April. Mirrors the GL, which
        // reverses COGS only for items restocked (write-offs stay in COGS).
        const cogsQuery = `
            SELECT
                COALESCE(SUM(si.cost_at_sale * si.quantity), 0) AS "totalCogs"
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.transaction_id AND s.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND si.store_id = $3
                ${channelClause('s')};
        `;
        const cogsResult = await db.query(cogsQuery, channelParams);

        const cogsReversalQuery = `
            SELECT
                COALESCE(SUM(si.cost_at_sale * ri.quantity), 0) AS "cogsReversed"
            FROM return_items ri
            JOIN returns r ON ri.return_id = r.id AND r.store_id = $3
            JOIN sales s ON r.original_sale_id = s.transaction_id AND s.store_id = $3
            JOIN sale_items si ON si.sale_id = r.original_sale_id AND si.product_id = ri.product_id AND si.store_id = $3
            WHERE r.timestamp BETWEEN $1 AND $2 AND ri.add_to_stock = true AND ri.store_id = $3
                ${channelClause('s')};
        `;
        const cogsReversalResult = await db.query(cogsReversalQuery, channelParams);

        // 3. Refunds (From returns table; joined to the original sale so a channel
        // filter applies consistently to refunds too)
        const refundsQuery = `
            SELECT
                COALESCE(SUM(r.subtotal_amount), 0) AS "totalRefunds"
            FROM returns r
            JOIN sales s ON r.original_sale_id = s.transaction_id AND s.store_id = r.store_id
            WHERE r.timestamp BETWEEN $1 AND $2 AND r.store_id = $3
            ${channelClause('s')};
        `;
        const refundsResult = await db.query(refundsQuery, channelParams);

        const grossRevenue = parseFloat(grossSalesResult.rows[0]?.grossRevenue || 0);
        const totalTransactions = parseInt(grossSalesResult.rows[0]?.totalTransactions || 0, 10);
        const cogsReversed = parseFloat(cogsReversalResult.rows[0]?.cogsReversed || 0);
        const totalCogs = parseFloat(cogsResult.rows[0]?.totalCogs || 0) - cogsReversed;
        const totalRefunds = parseFloat(refundsResult.rows[0]?.totalRefunds || 0);

        const netRevenue = grossRevenue - totalRefunds;
        const grossProfit = netRevenue - totalCogs;

        // 4. Operating Expenses
        const expensesQuery = `
            SELECT COALESCE(SUM(amount), 0) AS "totalExpenses"
            FROM expenses
            WHERE date BETWEEN $1 AND $2 AND store_id = $3;
        `;
        const expensesResult = await db.query(expensesQuery, [startDate, adjustedEndDate, storeId]);
        const totalOperatingExpenses = parseFloat(expensesResult.rows[0]?.totalExpenses || 0);

        // 4b. Expenses Breakdown by Account
        const expenseBreakdownQuery = `
            SELECT expense_account_name as title, SUM(amount) as amount
            FROM expenses
            WHERE date BETWEEN $1 AND $2 AND store_id = $3
            GROUP BY expense_account_name
            ORDER BY amount DESC;
        `;
        const expenseBreakdownResult = await db.query(expenseBreakdownQuery, [startDate, adjustedEndDate, storeId]);

        const netIncome = grossProfit - totalOperatingExpenses;

        const salesData = {
            totalRevenue: netRevenue,
            grossProfit: grossProfit,
            totalProfit: grossProfit, // Legacy support for "Gross Profit" shown as "Total Profit"
            netIncome: netIncome,
            totalOperatingExpenses: totalOperatingExpenses,
            expensesBreakdown: expenseBreakdownResult.rows.map(row => ({
                title: row.title,
                amount: parseFloat(row.amount)
            })),
            totalCogs: totalCogs,
            totalTransactions: totalTransactions
        };

        // --- Sales Trend ---
        // 1. Daily Gross Sales
        const trendGrossQuery = `
            SELECT
                DATE(s.timestamp)::text as date,
                COALESCE(SUM(s.subtotal - COALESCE(s.discount, 0)), 0) as gross_revenue
            FROM sales s
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND s.store_id = $3
            ${channelClause('s')}
            GROUP BY DATE(s.timestamp)
            ORDER BY date ASC;
        `;
        const trendGrossResult = await db.query(trendGrossQuery, channelParams);

        // 2. Daily COGS (full cost by sale date; restock reversals by return date)
        const trendCogsQuery = `
            SELECT
                DATE(s.timestamp)::text as date,
                COALESCE(SUM(si.cost_at_sale * si.quantity), 0) as cogs
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.transaction_id AND s.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND si.store_id = $3
                ${channelClause('s')}
            GROUP BY DATE(s.timestamp)
            ORDER BY date ASC;
        `;
        const trendCogsResult = await db.query(trendCogsQuery, channelParams);

        const trendCogsReversalQuery = `
            SELECT
                DATE(r.timestamp)::text as date,
                COALESCE(SUM(si.cost_at_sale * ri.quantity), 0) as cogs_reversed
            FROM return_items ri
            JOIN returns r ON ri.return_id = r.id AND r.store_id = $3
            JOIN sales s ON r.original_sale_id = s.transaction_id AND s.store_id = $3
            JOIN sale_items si ON si.sale_id = r.original_sale_id AND si.product_id = ri.product_id AND si.store_id = $3
            WHERE r.timestamp BETWEEN $1 AND $2 AND ri.add_to_stock = true AND ri.store_id = $3
                ${channelClause('s')}
            GROUP BY DATE(r.timestamp)
            ORDER BY date ASC;
        `;
        const trendCogsReversalResult = await db.query(trendCogsReversalQuery, channelParams);

        // 3. Daily Refunds
        const trendRefundsQuery = `
            SELECT
                DATE(r.timestamp)::text as date,
                COALESCE(SUM(r.subtotal_amount), 0) as refunds
            FROM returns r
            JOIN sales s ON r.original_sale_id = s.transaction_id AND s.store_id = r.store_id
            WHERE r.timestamp BETWEEN $1 AND $2 AND r.store_id = $3
            ${channelClause('s')}
            GROUP BY DATE(r.timestamp)
            ORDER BY date ASC;
        `;
        const trendRefundsResult = await db.query(trendRefundsQuery, channelParams);

        // 4. Daily Expenses
        const trendExpensesQuery = `
        SELECT
        DATE(date):: text as date,
            COALESCE(SUM(amount), 0) as expenses
            FROM expenses
            WHERE date BETWEEN $1 AND $2 AND store_id = $3
            GROUP BY DATE(date)
            ORDER BY date ASC;
        `;
        const trendExpensesResult = await db.query(trendExpensesQuery, [startDate, adjustedEndDate, storeId]);

        // Merge Data
        const trendMap: Record<string, { revenue: number, grossProfit: number, netIncome: number, expenses: number }> = {};

        // Helper to init date entry
        const getOrInit = (date: string) => {
            if (!trendMap[date]) trendMap[date] = { revenue: 0, grossProfit: 0, netIncome: 0, expenses: 0 };
            return trendMap[date];
        };

        // Add Gross Revenue
        trendGrossResult.rows.forEach(row => {
            const entry = getOrInit(row.date);
            entry.revenue += parseFloat(row.gross_revenue);
            entry.grossProfit += parseFloat(row.gross_revenue);
            entry.netIncome += parseFloat(row.gross_revenue);
        });

        // Subtract Refunds from Revenue, Gross Profit, and Net Income
        trendRefundsResult.rows.forEach(row => {
            const entry = getOrInit(row.date);
            const ref = parseFloat(row.refunds);
            entry.revenue -= ref;
            entry.grossProfit -= ref;
            entry.netIncome -= ref;
        });

        // Subtract COGS from Gross Profit and Net Income
        trendCogsResult.rows.forEach(row => {
            const entry = getOrInit(row.date);
            const cogs = parseFloat(row.cogs);
            entry.grossProfit -= cogs;
            entry.netIncome -= cogs;
        });

        // Add back COGS reversed by returns-to-stock on the day of the return
        trendCogsReversalResult.rows.forEach(row => {
            const entry = getOrInit(row.date);
            const reversed = parseFloat(row.cogs_reversed);
            entry.grossProfit += reversed;
            entry.netIncome += reversed;
        });

        // Subtract Expenses from Net Income only
        trendExpensesResult.rows.forEach(row => {
            const entry = getOrInit(row.date);
            const exp = parseFloat(row.expenses);
            entry.expenses += exp;
            entry.netIncome -= exp;
        });

        // For backward compatibility, also include "profit" which maps to grossProfit
        Object.keys(trendMap).forEach(date => {
            (trendMap[date] as any).profit = trendMap[date].grossProfit;
        });

        const salesTrend = trendMap;

        // --- Top Products by Revenue ---
        const topProductsRevenueQuery = `
            SELECT p.name, SUM(si.quantity - si.returned_quantity) as quantity, SUM(si.price_at_sale * (si.quantity - si.returned_quantity)) as revenue
            FROM sale_items si
                     JOIN products p ON si.product_id = p.id AND p.store_id = $3
                     JOIN sales s ON si.sale_id = s.transaction_id AND s.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND s.store_id = $3 AND si.store_id = $3
                ${channelClause('s')}
            GROUP BY p.name
            HAVING SUM(si.quantity - si.returned_quantity) > 0
            ORDER BY revenue DESC
            LIMIT 10;
        `;
        const topProductsRevenueResult = await db.query(topProductsRevenueQuery, channelParams);

        // --- Top Products by Quantity ---
        const topProductsQuantityQuery = `
            SELECT p.name, SUM(si.quantity - si.returned_quantity) as quantity
            FROM sale_items si
                     JOIN products p ON si.product_id = p.id AND p.store_id = $3
                     JOIN sales s ON si.sale_id = s.transaction_id AND s.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND s.store_id = $3 AND si.store_id = $3
                ${channelClause('s')}
            GROUP BY p.name
            HAVING SUM(si.quantity - si.returned_quantity) > 0
            ORDER BY quantity DESC
            LIMIT 10;
        `;
        const topProductsQuantityResult = await db.query(topProductsQuantityQuery, channelParams);

        // --- Sales by Category ---
        const salesByCategoryQuery = `
            SELECT c.name, SUM(si.price_at_sale * (si.quantity - si.returned_quantity)) as revenue
            FROM sale_items si
                     JOIN products p ON si.product_id = p.id AND p.store_id = $3
                     JOIN categories c ON p.category_id = c.id AND c.store_id = $3
                     JOIN sales s ON si.sale_id = s.transaction_id AND s.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND s.store_id = $3 AND si.store_id = $3
                ${channelClause('s')}
            GROUP BY c.name
            HAVING SUM(si.quantity - si.returned_quantity) > 0
            ORDER BY revenue DESC;
        `;
        const salesByCategoryResult = await db.query(salesByCategoryQuery, channelParams);

        // --- Cashflow from Journal Entries ---
        // Cash means CASH only. Accounts receivable is not cash — counting AR debits
        // as "inflow" booked credit sales as cash received before any money moved.
        const cashflowQuery = `
        SELECT
        DATE(je.date):: text as date,
            SUM(CASE WHEN jel.type = 'debit' THEN jel.amount ELSE 0 END) as inflow,
            SUM(CASE WHEN jel.type = 'credit' THEN jel.amount ELSE 0 END) as outflow
            FROM journal_entries je
                     JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
                     JOIN accounts a ON jel.account_id = a.id
            WHERE je.date BETWEEN $1 AND $2
              AND a.sub_type = 'cash'
              AND je.store_id = $3
            GROUP BY DATE(je.date)
            ORDER BY date ASC;
        `;
        const cashflowResult = await db.query(cashflowQuery, [startDate, adjustedEndDate, storeId]);

        // New query to see "where is the money going"
        const outflowBreakdownQuery = `
        SELECT
        a_dest.name as category,
            SUM(jel_dest.amount) as amount
            FROM journal_entry_lines jel_source
            JOIN journal_entries je ON jel_source.journal_entry_id = je.id
            JOIN journal_entry_lines jel_dest ON je.id = jel_dest.journal_entry_id
            JOIN accounts a_source ON jel_source.account_id = a_source.id
            JOIN accounts a_dest ON jel_dest.account_id = a_dest.id
            WHERE je.store_id = $3
              AND je.date BETWEEN $1 AND $2
              AND jel_source.type = 'credit'
              AND a_source.sub_type = 'cash'
              AND jel_dest.type = 'debit'
              AND a_dest.sub_type IS DISTINCT FROM 'cash'
            GROUP BY a_dest.name
            ORDER BY amount DESC;
        `;
        const outflowBreakdownResult = await db.query(outflowBreakdownQuery, [startDate, adjustedEndDate, storeId]);

        const cashflowTrend = cashflowResult.rows.reduce((acc, row) => {
            acc[row.date] = {
                inflow: parseFloat(row.inflow),
                outflow: parseFloat(row.outflow)
            };
            return acc;
        }, {});

        const outflowBreakdown = outflowBreakdownResult.rows.map(row => ({
            category: row.category,
            amount: parseFloat(row.amount)
        }));

        const totalCashflow = cashflowResult.rows.reduce((acc, row) => {
            acc.totalInflow += parseFloat(row.inflow);
            acc.totalOutflow += parseFloat(row.outflow);
            return acc;
        }, { totalInflow: 0, totalOutflow: 0 });

        // --- Other Aggregations ---
        // (These would also be converted to SQL for production-grade performance)
        // For now, keeping some logic in JS to simplify the transition.

        // --- Inventory Calculations ---
        const invQuery = `
        SELECT
        COALESCE(SUM(price * stock), 0) as "totalRetailValue",
            COALESCE(SUM(cost_price * stock), 0) as "totalCostValue",
            COALESCE(SUM(stock), 0) as "totalUnits",
            (SELECT COUNT(*) FROM products WHERE store_id = $1) as "totalProducts"
            FROM products WHERE status = 'active' AND store_id = $1;
        `;
        const invResult = await db.query(invQuery, [storeId]);
        const invData = invResult.rows[0] || { totalRetailValue: 0, totalCostValue: 0, totalUnits: 0, totalProducts: 0 };

        // --- Customer Calculations ---
        const customerQuery = `
        SELECT
            (SELECT COUNT(*) FROM customers WHERE store_id = $1) as "totalCustomers",
            COALESCE(SUM(account_balance), 0) as "totalStoreCreditOwed"
            FROM customers WHERE store_id = $1
            `;
        const customerResult = await db.query(customerQuery, [storeId]);
        const customerData = customerResult.rows[0] || { totalCustomers: '0', totalStoreCreditOwed: '0' };

        // --- Supplier Calculation ---
        const supplierQuery = `
            SELECT COUNT(*) as "totalSuppliers"
            FROM suppliers WHERE store_id = $1
            `;
        const supplierResult = await db.query(supplierQuery, [storeId]);
        const totalSuppliers = parseInt(supplierResult.rows[0]?.totalSuppliers || 0, 10);

        // --- Active Customers in Period ---
        const activeCustomersQuery = `
            SELECT COUNT(DISTINCT customer_id) as "activeCustomers"
            FROM sales
            WHERE timestamp BETWEEN $1 AND $2 AND customer_id IS NOT NULL AND store_id = $3
            `;
        const activeCustomersResult = await db.query(activeCustomersQuery, [startDate, adjustedEndDate, storeId]);
        const activeCustomers = activeCustomersResult.rows[0] ? parseInt(activeCustomersResult.rows[0].activeCustomers, 10) : 0;

        // --- New Customers in Period ---
        const newCustomersQuery = `
            SELECT COUNT(*) as "newCustomers"
            FROM customers
            WHERE created_at BETWEEN $1 AND $2 AND store_id = $3
            `;
        const newCustomersResult = await db.query(newCustomersQuery, [startDate, adjustedEndDate, storeId]);
        const newCustomers = newCustomersResult.rows[0] ? parseInt(newCustomersResult.rows[0].newCustomers, 10) : 0;

        // --- Sales by Channel ---
        // Same basis as totalRevenue (net-of-discount, ex-tax subtotal) so channel
        // shares sum to the headline figure instead of a tax-inclusive total.
        const salesByChannelQuery = `
            SELECT s.channel, SUM(s.subtotal - COALESCE(s.discount, 0)) as revenue, COUNT(*) as count
            FROM sales s
            WHERE s.timestamp BETWEEN $1 AND $2 AND ${saleFilter} AND s.store_id = $3
            GROUP BY s.channel;
        `;
        const salesByChannelResult = await db.query(salesByChannelQuery, [startDate, adjustedEndDate, storeId]);

        // --- Recent Orders ---

        const recentOrdersQuery = `
            SELECT s.transaction_id, s.timestamp, s.total, s.payment_status, s.channel, c.name as customer_name
            FROM sales s
            LEFT JOIN customers c ON s.customer_id = c.id
            WHERE s.store_id = $1
            ORDER BY s.timestamp DESC
            LIMIT 20;
        `;
        const recentOrdersResult = await db.query(recentOrdersQuery, [storeId]);

        // --- Final Report Object ---
        const report = {
            sales: {
                totalRevenue: salesData.totalRevenue,
                grossProfit: salesData.grossProfit,
                totalProfit: salesData.totalProfit, // Gross Profit for compatibility
                netIncome: salesData.netIncome,
                totalOperatingExpenses: salesData.totalOperatingExpenses,
                expensesBreakdown: salesData.expensesBreakdown,
                totalCogs: salesData.totalCogs,
                totalTransactions: salesData.totalTransactions,
                avgSaleValue: salesData.totalTransactions > 0 ? (salesData.totalRevenue / salesData.totalTransactions) : 0,
                grossMargin: salesData.totalRevenue > 0 ? ((salesData.grossProfit / salesData.totalRevenue) * 100) : 0,
                netMargin: salesData.totalRevenue > 0 ? ((salesData.netIncome / salesData.totalRevenue) * 100) : 0,
                salesTrend: salesTrend,
                salesByChannel: salesByChannelResult.rows.map(row => ({
                    channel: row.channel || 'pos',
                    revenue: parseFloat(row.revenue),
                    count: parseInt(row.count, 10)
                })),
                topProductsByRevenue: topProductsRevenueResult.rows.map(row => ({
                    name: row.name,
                    quantity: parseInt(row.quantity, 10),
                    revenue: parseFloat(row.revenue)
                })),
                topProductsByQuantity: topProductsQuantityResult.rows.map(row => ({
                    name: row.name,
                    quantity: parseInt(row.quantity, 10)
                })),
                salesByCategory: salesByCategoryResult.rows.map(row => ({
                    name: row.name,
                    revenue: parseFloat(row.revenue)
                })),
                recentOrders: recentOrdersResult.rows.map(row => ({
                    transactionId: row.transaction_id,
                    timestamp: row.timestamp,
                    total: parseFloat(row.total),
                    paymentStatus: row.payment_status,
                    customerName: row.customer_name,
                    channel: row.channel
                })),
            },
            inventory: {
                totalRetailValue: parseFloat(invData.totalRetailValue || 0),
                totalCostValue: parseFloat(invData.totalCostValue || 0),
                potentialProfit: (parseFloat(invData.totalRetailValue || 0) - parseFloat(invData.totalCostValue || 0)),
                totalUnits: parseInt(invData.totalUnits || 0, 10),
                totalProducts: parseInt(invData.totalProducts || 0, 10),
            },
            customers: {
                totalCustomers: parseInt(String(customerData.totalCustomers || 0), 10),
                totalSuppliers: totalSuppliers,
                totalStoreCreditOwed: parseFloat(String(customerData.totalStoreCreditOwed || 0)),
                activeCustomersInPeriod: activeCustomers,
                newCustomersInPeriod: newCustomers,
            },
            cashflow: {
                totalInflow: totalCashflow.totalInflow,
                totalOutflow: totalCashflow.totalOutflow,
                netCashflow: totalCashflow.totalInflow - totalCashflow.totalOutflow,
                cashflowTrend: cashflowTrend,
                outflowBreakdown: outflowBreakdown,
            }
        };

        res.status(200).json(toCamelCase(report));
    } catch (error) {
        console.error("Error generating dashboard data:", error);
        res.status(500).json({ message: "Error generating report data" });
    }
};

export const getDailySalesWithProducts = async (req: express.Request, res: express.Response) => {
    const { startDate, endDate } = req.query as { startDate: string, endDate: string };
    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'startDate and endDate query parameters are required.' });
    }
    const adjustedEndDate = new Date(new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();

    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const dailyItemsQuery = `
        SELECT
        DATE(s.timestamp):: text as date,
            p.name as product_name,
            SUM(si.quantity - si.returned_quantity) as quantity,
            SUM(si.price_at_sale * (si.quantity - si.returned_quantity)) as revenue
            FROM sale_items si
            JOIN products p ON si.product_id = p.id AND p.store_id = $3
            JOIN sales s ON si.sale_id = s.transaction_id AND s.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND s.fulfillment_status IS DISTINCT FROM 'cancelled' AND s.store_id = $3 AND si.store_id = $3
            GROUP BY DATE(s.timestamp), p.name
            HAVING SUM(si.quantity - si.returned_quantity) > 0
            ORDER BY DATE(s.timestamp) ASC, revenue DESC;
        `;
        const result = await db.query(dailyItemsQuery, [startDate, adjustedEndDate, storeId]);

        const grouped: Record<string, { date: string; totalRevenue: number; totalQuantity: number; items: { name: string; quantity: number; revenue: number }[] }> = {};
        for (const row of result.rows) {
            const dateStr = row.date;
            if (!grouped[dateStr]) {
                grouped[dateStr] = { date: dateStr, totalRevenue: 0, totalQuantity: 0, items: [] };
            }
            const qty = parseInt(row.quantity, 10);
            const rev = parseFloat(row.revenue);
            grouped[dateStr].items.push({ name: row.product_name, quantity: qty, revenue: rev });
            grouped[dateStr].totalQuantity += qty;
            grouped[dateStr].totalRevenue += rev;
        }

        // Return as ordered array by date
        const daily = Object.values(grouped).sort((a, b) => a.date.localeCompare(b.date));
        res.status(200).json(toCamelCase({ daily }));
    } catch (error) {
        console.error('Error generating daily sales with products:', error);
        res.status(500).json({ message: 'Error generating daily sales report' });
    }
};


export const getPersonalUseAdjustments = async (req: express.Request, res: express.Response) => {
    const { startDate, endDate } = req.query as { startDate: string, endDate: string };
    if (!startDate || !endDate) {
        return res.status(400).json({ message: 'startDate and endDate query parameters are required.' });
    }
    const adjustedEndDate = new Date(new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();

    try {
        const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
        if (!storeId) {
            return res.status(400).json({ message: 'Store context required' });
        }
        const q = `
            SELECT id, "timestamp", user_name, action, details
            FROM audit_logs
            WHERE action = 'Stock Adjusted'
              AND details ILIKE '%Reason: Personal Use%'
              AND store_id = $1
              AND "timestamp" BETWEEN $2 AND $3
            ORDER BY "timestamp" DESC;
        `;
        const result = await db.query(q, [storeId, startDate, adjustedEndDate]);

        const parseEntry = (row: any) => {
            const details: string = row.details || '';
            // Expected format: Product: "<name>" | From: <old> To: <new> | Reason: Personal Use
            const nameMatch = details.match(/Product:\s*"([^"]+)"/);
            const fromMatch = details.match(/From:\s*(\d+(?:\.\d+)?)/);
            const toMatch = details.match(/To:\s*(\d+(?:\.\d+)?)/);
            const productName = nameMatch ? nameMatch[1] : 'Unknown';
            const fromQty = fromMatch ? parseFloat(fromMatch[1]) : null;
            const toQty = toMatch ? parseFloat(toMatch[1]) : null;
            const change = (fromQty != null && toQty != null) ? (toQty - fromQty) : null;
            return {
                id: row.id,
                timestamp: row.timestamp,
                userName: row.user_name,
                productName,
                fromQty,
                toQty,
                change,
            };
        };

        const items = result.rows.map(parseEntry);
        res.status(200).json(toCamelCase({ items }));
    } catch (error) {
        console.error('Error generating personal use report:', error);
        res.status(500).json({ message: 'Error generating personal use report' });
    }
};
