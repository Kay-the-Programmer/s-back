import { GoogleGenerativeAI } from "@google/generative-ai";
import express from 'express';
import db from '../db_client';


if (!process.env.API_KEY) {
    console.warn("API_KEY environment variable not set for Gemini. AI features will fail.");
}

const genAI = new GoogleGenerativeAI(process.env.API_KEY || '');

export const generateDescription = async (req: express.Request, res: express.Response) => {
    const { productName, category } = req.body;

    if (!productName || !category) {
        return res.status(400).json({ message: 'Product name and category are required.' });
    }

    if (!process.env.API_KEY) {
        return res.status(500).json({ message: 'AI service is not configured on the server.' });
    }

    try {
        const prompt = `You are an expert copywriter for an e-commerce store.
          Generate a compelling, short (2-3 sentences) product description for a product with the following details:
          - Product Name: "${productName}"
          - Category: "${category}"
          
          The description should be engaging, highlight key benefits, and be suitable for a product listing. Do not include the product name or category in the description itself.
        `;

        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: 0.7,
                topP: 1,
                topK: 32,
                maxOutputTokens: 150,
            }
        });

        const result = await model.generateContent(prompt);
        const description = (result.response.text() ?? '').trim();
        res.status(200).json({ description });
    } catch (error: any) {
        console.error("Error generating description with Gemini API:", error);

        if (error.status === 429 || (error.message && error.message.includes('429'))) {
            return res.status(429).json({ message: 'Daily AI quota exceeded. Please try again later.' });
        }

        res.status(500).json({ message: 'Failed to generate AI description. Please try again.' });
    }
};

// Helper function to analyze query intent
function analyzeQueryIntent(query: string): {
    needsSales: boolean;
    needsInventory: boolean;
    needsCustomers: boolean;
    needsFinancial: boolean;
    needsOrders: boolean;
    needsReturns: boolean;
    needsProjection: boolean;
    goalAmount?: number;
    timeframe: 'today' | 'week' | 'month' | 'all';
} {
    const lowerQuery = query.toLowerCase();

    // Keyword detection for different data domains
    const salesKeywords = ['sale', 'sales', 'revenue', 'transaction', 'selling', 'sold', 'top product', 'best seller', 'performance'];
    const inventoryKeywords = ['inventory', 'stock', 'product', 'item', 'reorder', 'low stock', 'out of stock'];
    const customerKeywords = ['customer', 'client', 'buyer', 'top customer', 'new customer'];
    const financialKeywords = ['profit', 'expense', 'cost', 'margin', 'receivable', 'payable', 'financial', 'money'];
    const orderKeywords = ['purchase order', 'po', 'supplier', 'order', 'pending'];
    const returnKeywords = ['return', 'refund', 'returned'];
    const projectionKeywords = ['million', 'reach', 'goal', 'how long', 'forecast', 'projection', 'estimate', 'predict', 'when will', 'how much will', 'project', 'make'];

    // Timeframe detection
    let timeframe: 'today' | 'week' | 'month' | 'all' = 'today';
    if (lowerQuery.includes('week') || lowerQuery.includes('7 day')) timeframe = 'week';
    else if (lowerQuery.includes('month') || lowerQuery.includes('30 day')) timeframe = 'month';
    else if (lowerQuery.includes('overview') || lowerQuery.includes('snapshot') || lowerQuery.includes('everything')) timeframe = 'all';

    // Goal amount detection
    let goalAmount: number | undefined;
    if (lowerQuery.includes('million')) {
        const millionMatch = lowerQuery.match(/(\d+(?:\.\d+)?)\s*million/);
        goalAmount = millionMatch ? parseFloat(millionMatch[1]) * 1000000 : 1000000;
    } else {
        // Try to extract specific dollar amounts like "$10,000" or "10000"
        const dollarMatch = query.match(/\$([\d,]+(?:\.\d+)?)/);
        if (dollarMatch) {
            goalAmount = parseFloat(dollarMatch[1].replace(/,/g, ''));
        } else {
            const numberMatch = lowerQuery.match(/(\d+(?:,\d+)*(?:\.\d+)?)/);
            if (numberMatch && projectionKeywords.some(kw => lowerQuery.includes(kw))) {
                goalAmount = parseFloat(numberMatch[1].replace(/,/g, ''));
            }
        }
    }

    const needsProjection = projectionKeywords.some(kw => lowerQuery.includes(kw));

    return {
        needsSales: salesKeywords.some(kw => lowerQuery.includes(kw)) || lowerQuery.includes('overview') || lowerQuery.includes('snapshot') || needsProjection,
        needsInventory: inventoryKeywords.some(kw => lowerQuery.includes(kw)) || lowerQuery.includes('overview') || lowerQuery.includes('snapshot'),
        needsCustomers: customerKeywords.some(kw => lowerQuery.includes(kw)),
        needsFinancial: financialKeywords.some(kw => lowerQuery.includes(kw)),
        needsOrders: orderKeywords.some(kw => lowerQuery.includes(kw)),
        needsReturns: returnKeywords.some(kw => lowerQuery.includes(kw)),
        needsProjection,
        goalAmount,
        timeframe
    };
}

// Context gathering functions
async function getSalesContext(storeId: string, timeframe: string) {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Month-to-date calculation
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

    // Today's sales
    const todaySales = await db.query(
        `SELECT 
            COALESCE(SUM(total), 0) as total, 
            COUNT(*) as count,
            COALESCE(AVG(total), 0) as avg_value,
            SUM(CASE WHEN channel = 'online' THEN total ELSE 0 END) as online_total,
            SUM(CASE WHEN channel = 'pos' THEN total ELSE 0 END) as pos_total
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") = $2`,
        [storeId, today]
    );

    // Week comparison
    const weekSales = await db.query(
        `SELECT 
            COALESCE(SUM(total), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2`,
        [storeId, weekAgo]
    );

    // Month-to-date sales
    const monthSales = await db.query(
        `SELECT 
            COALESCE(SUM(total), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2`,
        [storeId, monthStart]
    );

    // Previous month for comparison
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
    const prevMonthSales = await db.query(
        `SELECT 
            COALESCE(SUM(total), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND DATE("timestamp") <= $3`,
        [storeId, prevMonthStart, prevMonthEnd]
    );

    // Top products by revenue
    const topProducts = await db.query(
        `SELECT 
            p.name,
            COALESCE(SUM(si.quantity * si.price_at_sale), 0) as revenue,
            COALESCE(SUM(si.quantity), 0) as units_sold
         FROM sale_items si
         JOIN products p ON si.product_id = p.id
         JOIN sales s ON si.sale_id = s.transaction_id
         WHERE si.store_id = $1 AND DATE(s."timestamp") >= $2
         GROUP BY p.id, p.name
         ORDER BY revenue DESC
         LIMIT 5`,
        [storeId, timeframe === 'today' ? today : timeframe === 'week' ? weekAgo : monthAgo]
    );

    // Payment method distribution
    const paymentMethods = await db.query(
        `SELECT 
            method,
            COALESCE(SUM(amount), 0) as total
         FROM payments p
         JOIN sales s ON p.sale_id = s.transaction_id
         WHERE p.store_id = $1 AND DATE(p.date) >= $2
         GROUP BY method`,
        [storeId, timeframe === 'today' ? today : weekAgo]
    );

    return {
        today: todaySales.rows[0],
        week: weekSales.rows[0],
        month: monthSales.rows[0],
        prevMonth: prevMonthSales.rows[0],
        topProducts: topProducts.rows,
        paymentMethods: paymentMethods.rows
    };
}

async function getInventoryContext(storeId: string) {
    // Low stock items
    const lowStock = await db.query(
        `SELECT name, stock, reorder_point, price
         FROM products
         WHERE store_id = $1 AND stock <= COALESCE(reorder_point, 10) AND status = 'active'
         ORDER BY stock ASC
         LIMIT 10`,
        [storeId]
    );

    // Inventory value and summary
    const inventorySummary = await db.query(
        `SELECT 
            COUNT(*) as total_products,
            COALESCE(SUM(stock * COALESCE(cost_price, price * 0.6)), 0) as inventory_value,
            COALESCE(SUM(stock), 0) as total_units,
            COUNT(CASE WHEN stock <= COALESCE(reorder_point, 10) THEN 1 END) as low_stock_count,
            COUNT(CASE WHEN stock = 0 THEN 1 END) as out_of_stock_count
         FROM products
         WHERE store_id = $1 AND status = 'active'`,
        [storeId]
    );

    // Top stock items by value
    const topStockValue = await db.query(
        `SELECT name, stock, price, (stock * COALESCE(cost_price, price * 0.6)) as stock_value
         FROM products
         WHERE store_id = $1 AND status = 'active'
         ORDER BY stock_value DESC
         LIMIT 5`,
        [storeId]
    );

    return {
        lowStock: lowStock.rows,
        summary: inventorySummary.rows[0],
        topValue: topStockValue.rows
    };
}

async function getCustomerContext(storeId: string) {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Top customers by spend
    const topCustomers = await db.query(
        `SELECT 
            c.name,
            COALESCE(SUM(s.total), 0) as total_spent,
            COUNT(s.transaction_id) as purchase_count
         FROM customers c
         LEFT JOIN sales s ON c.id = s.customer_id
         WHERE c.store_id = $1 AND (s.store_id IS NULL OR s.store_id = $1)
         GROUP BY c.id, c.name
         ORDER BY total_spent DESC
         LIMIT 5`,
        [storeId]
    );

    // New customers this month
    const newCustomers = await db.query(
        `SELECT COUNT(*) as count
         FROM customers
         WHERE store_id = $1 AND DATE(created_at) >= $2`,
        [storeId, monthAgo]
    );

    // Customer summary
    const customerSummary = await db.query(
        `SELECT 
            COUNT(*) as total_customers,
            COALESCE(AVG(account_balance), 0) as avg_balance,
            COALESCE(SUM(store_credit), 0) as total_store_credit
         FROM customers
         WHERE store_id = $1`,
        [storeId]
    );

    return {
        topCustomers: topCustomers.rows,
        newCustomersCount: newCustomers.rows[0].count,
        summary: customerSummary.rows[0]
    };
}

async function getFinancialContext(storeId: string) {
    const today = new Date().toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Revenue and COGS
    const financials = await db.query(
        `SELECT 
            COALESCE(SUM(s.total), 0) as revenue,
            COALESCE(SUM(si.quantity * si.cost_at_sale), 0) as cogs
         FROM sales s
         LEFT JOIN sale_items si ON s.transaction_id = si.sale_id
         WHERE s.store_id = $1 AND DATE(s."timestamp") >= $2`,
        [storeId, monthAgo]
    );

    const revenue = parseFloat(financials.rows[0].revenue || 0);
    const cogs = parseFloat(financials.rows[0].cogs || 0);
    const grossProfit = revenue - cogs;
    const profitMargin = revenue > 0 ? ((grossProfit / revenue) * 100).toFixed(1) : '0';

    // Accounts receivable
    const receivable = await db.query(
        `SELECT COALESCE(SUM(total - amount_paid), 0) as amount
         FROM sales
         WHERE store_id = $1 AND payment_status IN ('unpaid', 'partially_paid')`,
        [storeId]
    );

    return {
        revenue,
        cogs,
        grossProfit,
        profitMargin: `${profitMargin}%`,
        accountsReceivable: parseFloat(receivable.rows[0].amount || 0)
    };
}

async function getOrdersContext(storeId: string) {
    // Pending purchase orders
    const pendingOrders = await db.query(
        `SELECT 
            po_number,
            supplier_name,
            status,
            total,
            expected_at
         FROM purchase_orders
         WHERE store_id = $1 AND status IN ('draft', 'ordered', 'partially_received')
         ORDER BY created_at DESC
         LIMIT 5`,
        [storeId]
    );

    return {
        pendingOrders: pendingOrders.rows
    };
}

async function getReturnsContext(storeId: string) {
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Returns summary
    const returnsSummary = await db.query(
        `SELECT 
            COUNT(*) as return_count,
            COALESCE(SUM(refund_amount), 0) as total_refunded
         FROM returns
         WHERE store_id = $1 AND DATE("timestamp") >= $2`,
        [storeId, monthAgo]
    );

    // Most returned products
    const topReturned = await db.query(
        `SELECT 
            ri.product_name,
            COALESCE(SUM(ri.quantity), 0) as return_count
         FROM return_items ri
         JOIN returns r ON ri.return_id = r.id
         WHERE ri.store_id = $1 AND DATE(r."timestamp") >= $2
         GROUP BY ri.product_name
         ORDER BY return_count DESC
         LIMIT 3`,
        [storeId, monthAgo]
    );

    return {
        summary: returnsSummary.rows[0],
        topReturned: topReturned.rows
    };
}

async function getProjectionContext(storeId: string, goalAmount?: number) {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get month-to-date sales
    const monthSales = await db.query(
        `SELECT 
            COALESCE(SUM(total), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2`,
        [storeId, monthStart]
    );

    // Get last 30 days for comparison
    const last30Days = await db.query(
        `SELECT 
            COALESCE(SUM(total), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2`,
        [storeId, monthAgo]
    );

    // Get last 7 days
    const last7Days = await db.query(
        `SELECT 
            COALESCE(SUM(total), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2`,
        [storeId, weekAgo]
    );

    // Calculate averages
    const daysInMonth = Math.max(1, Math.ceil((today.getTime() - new Date(monthStart).getTime()) / (1000 * 60 * 60 * 24)));
    const monthTotal = parseFloat(monthSales.rows[0].total || 0);
    const last30Total = parseFloat(last30Days.rows[0].total || 0);
    const last7Total = parseFloat(last7Days.rows[0].total || 0);

    const avgDailyRevenue = daysInMonth > 0 ? monthTotal / daysInMonth : 0;
    const avgDailyRevenue30 = last30Total / 30;
    const avgDailyRevenue7 = last7Total / 7;
    const avgWeeklyRevenue = avgDailyRevenue7 * 7;
    const avgMonthlyRevenue = avgDailyRevenue30 * 30;

    // Calculate growth rate (comparing recent 7 days vs previous 23 days)
    const prev23DaysStart = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const prev23DaysEnd = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const prev23Days = await db.query(
        `SELECT COALESCE(SUM(total), 0) as total
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND DATE("timestamp") < $3`,
        [storeId, prev23DaysStart, prev23DaysEnd]
    );
    const prev23Total = parseFloat(prev23Days.rows[0].total || 0);
    const avgPrev23 = prev23Total / 23;
    const growthRate = avgPrev23 > 0 ? ((avgDailyRevenue7 - avgPrev23) / avgPrev23) * 100 : 0;

    // Project month-end revenue
    const daysInCurrentMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    const remainingDays = daysInCurrentMonth - daysInMonth;
    const projectedMonthEnd = monthTotal + (avgDailyRevenue * remainingDays);

    // Calculate time to goal if goal amount is provided
    let daysToGoal: number | null = null;
    let weeksToGoal: number | null = null;
    let monthsToGoal: number | null = null;
    if (goalAmount && avgDailyRevenue > 0) {
        daysToGoal = Math.ceil(goalAmount / avgDailyRevenue);
        weeksToGoal = Math.ceil(daysToGoal / 7);
        monthsToGoal = Math.ceil(daysToGoal / 30);
    }

    return {
        monthToDate: {
            total: monthTotal,
            count: monthSales.rows[0].count,
            daysElapsed: daysInMonth,
            avgDaily: avgDailyRevenue
        },
        averages: {
            daily: avgDailyRevenue,
            daily7: avgDailyRevenue7,
            daily30: avgDailyRevenue30,
            weekly: avgWeeklyRevenue,
            monthly: avgMonthlyRevenue
        },
        growthRate: growthRate,
        projectedMonthEnd: projectedMonthEnd,
        goalProjection: goalAmount ? {
            goalAmount,
            daysToGoal,
            weeksToGoal,
            monthsToGoal,
            estimatedDate: daysToGoal ? new Date(Date.now() + daysToGoal * 24 * 60 * 60 * 1000).toISOString().split('T')[0] : null
        } : null
    };
}

export const handleChat = async (req: express.Request, res: express.Response) => {
    try {
        const { query } = req.body;
        const user = req.user;
        const storeId = user?.currentStoreId;

        if (!query) return res.status(400).json({ message: 'Query is required' });
        if (!storeId) return res.status(400).json({ message: 'Store context is required' });

        if (!process.env.API_KEY) {
            return res.status(500).json({ message: 'AI service is not configured on the server.' });
        }

        // Analyze what data the user is asking for
        const intent = analyzeQueryIntent(query);

        // Gather only the necessary context based on query intent
        const contextParts: string[] = [];

        if (intent.needsSales) {
            const salesData = await getSalesContext(storeId, intent.timeframe);
            contextParts.push(`
SALES DATA:
- Today: $${parseFloat(salesData.today.total || 0).toFixed(2)} from ${salesData.today.count} transactions (avg: $${parseFloat(salesData.today.avg_value || 0).toFixed(2)})
- This Week: $${parseFloat(salesData.week.total || 0).toFixed(2)} from ${salesData.week.count} transactions
- This Month: $${parseFloat(salesData.month.total || 0).toFixed(2)} from ${salesData.month.count} transactions
- Previous Month: $${parseFloat(salesData.prevMonth.total || 0).toFixed(2)} from ${salesData.prevMonth.count} transactions
- Channel Split: Online $${parseFloat(salesData.today.online_total || 0).toFixed(2)} | POS $${parseFloat(salesData.today.pos_total || 0).toFixed(2)}
- Top Products: ${salesData.topProducts.map(p => `${p.name} ($${parseFloat(p.revenue).toFixed(2)}, ${p.units_sold} units)`).join(', ') || 'No sales data'}
- Payment Methods: ${salesData.paymentMethods.map(pm => `${pm.method}: $${parseFloat(pm.total).toFixed(2)}`).join(', ') || 'No payment data'}
            `);
        }

        if (intent.needsProjection) {
            const projectionData = await getProjectionContext(storeId, intent.goalAmount);
            let projectionText = `
SALES PROJECTIONS & FORECASTS:
- Month-to-Date: $${projectionData.monthToDate.total.toFixed(2)} (${projectionData.monthToDate.daysElapsed} days elapsed)
- Average Daily Revenue: $${projectionData.averages.daily.toFixed(2)} (this month) | $${projectionData.averages.daily7.toFixed(2)} (last 7 days) | $${projectionData.averages.daily30.toFixed(2)} (last 30 days)
- Average Weekly Revenue: $${projectionData.averages.weekly.toFixed(2)}
- Average Monthly Revenue: $${projectionData.averages.monthly.toFixed(2)}
- Projected Month-End Revenue: $${projectionData.projectedMonthEnd.toFixed(2)}
- Growth Rate: ${projectionData.growthRate > 0 ? '+' : ''}${projectionData.growthRate.toFixed(1)}% (7-day vs previous 23-day average)`;

            if (projectionData.goalProjection) {
                projectionText += `\n- Goal: $${projectionData.goalProjection.goalAmount.toLocaleString()}
- Time to Reach Goal: ${projectionData.goalProjection.daysToGoal} days (${projectionData.goalProjection.weeksToGoal} weeks / ${projectionData.goalProjection.monthsToGoal} months)
- Estimated Date: ${projectionData.goalProjection.estimatedDate}`;
            }
            contextParts.push(projectionText);
        }

        if (intent.needsInventory) {
            const inventoryData = await getInventoryContext(storeId);
            contextParts.push(`
INVENTORY DATA:
- Total Products: ${inventoryData.summary.total_products}
- Inventory Value: $${parseFloat(inventoryData.summary.inventory_value || 0).toFixed(2)}
- Total Units: ${parseFloat(inventoryData.summary.total_units || 0).toFixed(0)}
- Low Stock Items: ${inventoryData.summary.low_stock_count} products
- Out of Stock: ${inventoryData.summary.out_of_stock_count} products
- Critical Low Stock: ${inventoryData.lowStock.map(p => `${p.name} (${parseFloat(p.stock).toFixed(0)} units, reorder at ${p.reorder_point})`).slice(0, 5).join(', ') || 'None'}
            `);
        }

        if (intent.needsCustomers) {
            const customerData = await getCustomerContext(storeId);
            contextParts.push(`
CUSTOMER DATA:
- Total Customers: ${customerData.summary.total_customers}
- New Customers (30 days): ${customerData.newCustomersCount}
- Total Store Credit Outstanding: $${parseFloat(customerData.summary.total_store_credit || 0).toFixed(2)}
- Top Customers: ${customerData.topCustomers.map(c => `${c.name} ($${parseFloat(c.total_spent || 0).toFixed(2)}, ${c.purchase_count} purchases)`).join(', ') || 'No customer data'}
            `);
        }

        if (intent.needsFinancial) {
            const financialData = await getFinancialContext(storeId);
            contextParts.push(`
FINANCIAL DATA (Last 30 Days):
- Revenue: $${financialData.revenue.toFixed(2)}
- COGS: $${financialData.cogs.toFixed(2)}
- Gross Profit: $${financialData.grossProfit.toFixed(2)}
- Profit Margin: ${financialData.profitMargin}
- Accounts Receivable: $${financialData.accountsReceivable.toFixed(2)}
            `);
        }

        if (intent.needsOrders) {
            const ordersData = await getOrdersContext(storeId);
            contextParts.push(`
PURCHASE ORDERS:
- Pending Orders: ${ordersData.pendingOrders.map(po => `PO ${po.po_number} - ${po.supplier_name} ($${parseFloat(po.total).toFixed(2)}, ${po.status})`).join(', ') || 'No pending orders'}
            `);
        }

        if (intent.needsReturns) {
            const returnsData = await getReturnsContext(storeId);
            contextParts.push(`
RETURNS DATA (Last 30 Days):
- Total Returns: ${returnsData.summary.return_count}
- Total Refunded: $${parseFloat(returnsData.summary.total_refunded || 0).toFixed(2)}
- Most Returned: ${returnsData.topReturned.map(r => `${r.product_name} (${parseFloat(r.return_count).toFixed(0)}x)`).join(', ') || 'No returns'}
            `);
        }

        // If no specific intent detected, provide overview
        if (contextParts.length === 0) {
            const salesData = await getSalesContext(storeId, 'today');
            const inventoryData = await getInventoryContext(storeId);
            contextParts.push(`
QUICK OVERVIEW:
- Today's Sales: $${parseFloat(salesData.today.total || 0).toFixed(2)} (${salesData.today.count} transactions)
- Low Stock Items: ${inventoryData.summary.low_stock_count}
            `);
        }

        // Construct enhanced AI prompt
        const systemContext = `You are "Salepilot Assistant", an intelligent business intelligence assistant for ${user?.name}.

Current Date: ${new Date().toISOString().split('T')[0]}
Store ID: ${storeId}

BUSINESS DATA:
${contextParts.join('\n')}

USER QUESTION: "${query}"

INSTRUCTIONS:
- Provide a clear, conversational answer using the data above
- Use specific numbers and metrics from the data
- If asked about trends, compare current vs historical data when available
- Highlight important insights (e.g., best sellers, low stock alerts, profit margins)
- For projection questions, explain the calculation methodology briefly (e.g., "Based on your current month's average daily revenue of $X...")
- When providing timelines, give multiple formats (days, weeks, months) for clarity
- If growth rate is positive/negative, mention it and how it affects projections
- Be concise but informative (2-4 sentences unless detailed analysis is requested)
- Use business terminology appropriately
- If data is missing or zero, acknowledge it naturally and explain limitations
- Format numbers clearly with $ for currency and use thousands separators for large numbers
- For projections with limited data, mention the confidence level or recommend collecting more data
- End with a helpful suggestion or next action if appropriate`;

        // Call AI with enhanced context
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 500,
            }
        });

        const result = await model.generateContent(systemContext);
        res.json({ response: result.response.text() });

    } catch (error: any) {
        console.error('AI Chat Error:', error);

        // Handle Rate Limiting (Quota Exceeded)
        if (error.status === 429 || (error.message && error.message.includes('429'))) {
            return res.status(429).json({
                message: 'Daily AI quota exceeded. Please try again later or upgrade to a premium plan.',
                error: 'QuotaExceeded'
            });
        }

        res.status(500).json({
            message: 'Failed to process AI query',
            error: error instanceof Error ? error.message : String(error)
        });
    }
};