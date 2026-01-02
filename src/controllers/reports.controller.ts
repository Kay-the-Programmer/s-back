import express from 'express';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';

export const getDashboardData = async (req: express.Request, res: express.Response) => {
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
        // --- Sales Calculations ---
        const salesQuery = `
            SELECT
                COALESCE(SUM(s.total), 0) AS "totalRevenue",
                COALESCE(SUM(s.total) - SUM(si.cost_at_sale * si.quantity), 0) AS "totalProfit",
                COALESCE(SUM(si.cost_at_sale * si.quantity), 0) AS "totalCogs",
                COUNT(DISTINCT s.transaction_id) AS "totalTransactions"
            FROM sales s
            JOIN sale_items si ON s.transaction_id = si.sale_id AND si.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND s.payment_status = 'paid' AND s.store_id = $3;
        `;
        const salesResult = await db.query(salesQuery, [startDate, adjustedEndDate, storeId]);
        const salesData = salesResult.rows[0];

        // --- Sales Trend ---
        const trendQuery = `
            SELECT
                DATE(s.timestamp) as date,
                SUM(s.total) as revenue,
                SUM(s.total) - SUM(si.cost_at_sale * si.quantity) as profit
            FROM sales s
            JOIN sale_items si ON s.transaction_id = si.sale_id AND si.store_id = $3
            WHERE s.timestamp BETWEEN $1 AND $2 AND s.payment_status = 'paid' AND s.store_id = $3 AND si.store_id = $3
            GROUP BY DATE(s.timestamp)
            ORDER BY date ASC;
        `;
        const trendResult = await db.query(trendQuery, [startDate, adjustedEndDate, storeId]);
        const salesTrend = trendResult.rows.reduce((acc, row) => {
            const dateStr = new Date(row.date).toISOString().split('T')[0];
            acc[dateStr] = { revenue: parseFloat(row.revenue), profit: parseFloat(row.profit) };
            return acc;
        }, {});

        // --- Top Products by Revenue ---
        const topProductsRevenueQuery = `
            SELECT p.name, SUM(si.quantity) as quantity, SUM(si.price_at_sale * si.quantity) as revenue
            FROM sale_items si
                     JOIN products p ON si.product_id = p.id
                     JOIN sales s ON si.sale_id = s.transaction_id
            WHERE s.timestamp BETWEEN $1 AND $2 AND s.payment_status = 'paid' AND s.store_id = $3
            GROUP BY p.name
            ORDER BY revenue DESC
            LIMIT 10;
        `;
        const topProductsRevenueResult = await db.query(topProductsRevenueQuery, [startDate, adjustedEndDate, storeId]);

        // --- Top Products by Quantity ---
        const topProductsQuantityQuery = `
            SELECT p.name, SUM(si.quantity) as quantity
            FROM sale_items si
                     JOIN products p ON si.product_id = p.id
                     JOIN sales s ON si.sale_id = s.transaction_id
            WHERE s.timestamp BETWEEN $1 AND $2 AND s.payment_status = 'paid' AND s.store_id = $3
            GROUP BY p.name
            ORDER BY quantity DESC
            LIMIT 10;
        `;
        const topProductsQuantityResult = await db.query(topProductsQuantityQuery, [startDate, adjustedEndDate, storeId]);

        // --- Sales by Category ---
        const salesByCategoryQuery = `
            SELECT c.name, SUM(si.price_at_sale * si.quantity) as revenue
            FROM sale_items si
                     JOIN products p ON si.product_id = p.id
                     JOIN categories c ON p.category_id = c.id
                     JOIN sales s ON si.sale_id = s.transaction_id
            WHERE s.timestamp BETWEEN $1 AND $2 AND s.payment_status = 'paid' AND s.store_id = $3
            GROUP BY c.name
            ORDER BY revenue DESC;
        `;
        const salesByCategoryResult = await db.query(salesByCategoryQuery, [startDate, adjustedEndDate, storeId]);

        // --- Cashflow from Journal Entries ---
        const cashflowQuery = `
            SELECT
                DATE(je.date) as date,
                SUM(CASE WHEN jel.type = 'debit' AND a.type = 'asset' THEN jel.amount ELSE 0 END) as inflow,
                SUM(CASE WHEN jel.type = 'credit' AND a.type = 'asset' THEN jel.amount ELSE 0 END) as outflow
            FROM journal_entries je
                     JOIN journal_entry_lines jel ON je.id = jel.journal_entry_id
                     JOIN accounts a ON jel.account_id = a.id
            WHERE je.date BETWEEN $1 AND $2 AND a.sub_type IN ('cash', 'accounts_receivable')
            GROUP BY DATE(je.date)
            ORDER BY date ASC;
        `;
        const cashflowResult = await db.query(cashflowQuery, [startDate, adjustedEndDate]);

        const cashflowTrend = cashflowResult.rows.reduce((acc, row) => {
            const dateStr = new Date(row.date).toISOString().split('T')[0];
            acc[dateStr] = {
                inflow: parseFloat(row.inflow),
                outflow: parseFloat(row.outflow)
            };
            return acc;
        }, {});

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
                COALESCE(SUM(stock), 0) as "totalUnits"
            FROM products WHERE status = 'active' AND store_id = $1;
        `;
        const invResult = await db.query(invQuery, [storeId]);
        const invData = invResult.rows[0];

        // --- Customer Calculations ---
        const customerQuery = `
            SELECT
                    (SELECT COUNT(*) FROM customers WHERE store_id = $1) as "totalCustomers",
                    COALESCE(SUM(account_balance), 0) as "totalStoreCreditOwed"
            FROM customers WHERE store_id = $1
        `;
        const customerResult = await db.query(customerQuery, [storeId]);
        const customerData = customerResult.rows[0];

        // --- Active Customers in Period ---
        const activeCustomersQuery = `
            SELECT COUNT(DISTINCT customer_id) as "activeCustomers"
            FROM sales
            WHERE timestamp BETWEEN $1 AND $2 AND customer_id IS NOT NULL AND store_id = $3
        `;
        const activeCustomersResult = await db.query(activeCustomersQuery, [startDate, adjustedEndDate, storeId]);
        const activeCustomers = parseInt(activeCustomersResult.rows[0].activeCustomers, 10);

        // --- New Customers in Period ---
        const newCustomersQuery = `
            SELECT COUNT(*) as "newCustomers"
            FROM customers
            WHERE created_at BETWEEN $1 AND $2 AND store_id = $3
        `;
        const newCustomersResult = await db.query(newCustomersQuery, [startDate, adjustedEndDate, storeId]);
        const newCustomers = parseInt(newCustomersResult.rows[0].newCustomers, 10);

        // --- Final Report Object ---
        const report = {
            sales: {
                totalRevenue: parseFloat(salesData.totalRevenue),
                totalProfit: parseFloat(salesData.totalProfit),
                totalCogs: parseFloat(salesData.totalCogs),
                totalTransactions: parseInt(salesData.totalTransactions, 10),
                avgSaleValue: salesData.totalTransactions > 0 ? salesData.totalRevenue / salesData.totalTransactions : 0,
                grossMargin: salesData.totalRevenue > 0 ? (salesData.totalProfit / salesData.totalRevenue) * 100 : 0,
                salesTrend: salesTrend,
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
            },
            inventory: {
                totalRetailValue: parseFloat(invData.totalRetailValue),
                totalCostValue: parseFloat(invData.totalCostValue),
                potentialProfit: invData.totalRetailValue - invData.totalCostValue,
                totalUnits: parseInt(invData.totalUnits, 10),
            },
            customers: {
                totalCustomers: parseInt(customerData.totalCustomers, 10),
                totalStoreCreditOwed: parseFloat(customerData.totalStoreCreditOwed),
                activeCustomersInPeriod: activeCustomers,
                newCustomersInPeriod: newCustomers,
            },
            cashflow: {
                totalInflow: totalCashflow.totalInflow,
                totalOutflow: totalCashflow.totalOutflow,
                netCashflow: totalCashflow.totalInflow - totalCashflow.totalOutflow,
                cashflowTrend: cashflowTrend,
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
                DATE(s.timestamp) as date,
                p.name as product_name,
                SUM(si.quantity) as quantity,
                SUM(si.price_at_sale * si.quantity) as revenue
            FROM sale_items si
            JOIN products p ON si.product_id = p.id
            JOIN sales s ON si.sale_id = s.transaction_id
            WHERE s.timestamp BETWEEN $1 AND $2 AND s.payment_status = 'paid' AND s.store_id = $3
            GROUP BY DATE(s.timestamp), p.name
            ORDER BY DATE(s.timestamp) ASC, revenue DESC;
        `;
        const result = await db.query(dailyItemsQuery, [startDate, adjustedEndDate, storeId]);

        const grouped: Record<string, { date: string; totalRevenue: number; totalQuantity: number; items: { name: string; quantity: number; revenue: number }[] }> = {};
        for (const row of result.rows) {
            const dateStr = new Date(row.date).toISOString().split('T')[0];
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
