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

    // Timeframe detection
    let timeframe: 'today' | 'week' | 'month' | 'all' = 'today';
    if (lowerQuery.includes('week') || lowerQuery.includes('7 day')) timeframe = 'week';
    else if (lowerQuery.includes('month') || lowerQuery.includes('30 day')) timeframe = 'month';
    else if (lowerQuery.includes('overview') || lowerQuery.includes('snapshot') || lowerQuery.includes('everything')) timeframe = 'all';

    return {
        needsSales: salesKeywords.some(kw => lowerQuery.includes(kw)) || lowerQuery.includes('overview') || lowerQuery.includes('snapshot'),
        needsInventory: inventoryKeywords.some(kw => lowerQuery.includes(kw)) || lowerQuery.includes('overview') || lowerQuery.includes('snapshot'),
        needsCustomers: customerKeywords.some(kw => lowerQuery.includes(kw)),
        needsFinancial: financialKeywords.some(kw => lowerQuery.includes(kw)),
        needsOrders: orderKeywords.some(kw => lowerQuery.includes(kw)),
        needsReturns: returnKeywords.some(kw => lowerQuery.includes(kw)),
        timeframe
    };
}

// Context gathering functions
async function getSalesContext(storeId: string, timeframe: string) {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

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
- Channel Split: Online $${parseFloat(salesData.today.online_total || 0).toFixed(2)} | POS $${parseFloat(salesData.today.pos_total || 0).toFixed(2)}
- Top Products: ${salesData.topProducts.map(p => `${p.name} ($${parseFloat(p.revenue).toFixed(2)}, ${p.units_sold} units)`).join(', ') || 'No sales data'}
- Payment Methods: ${salesData.paymentMethods.map(pm => `${pm.method}: $${parseFloat(pm.total).toFixed(2)}`).join(', ') || 'No payment data'}
            `);
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
- Be concise but informative (2-4 sentences unless detailed analysis is requested)
- Use business terminology appropriately
- If data is missing or zero, acknowledge it naturally
- Format numbers clearly with $ for currency
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