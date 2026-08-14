import { GoogleGenerativeAI } from "@google/generative-ai";
import express from 'express';
import axios from 'axios';
import db from '../db_client';
import { logAiUsage } from '../middleware/ai-limit.middleware';
import { SUBSCRIPTION_PLANS } from '../services/subscription.service';
import { MODULES, isModuleEnabled } from '../services/entitlements.service';


if (!process.env.API_KEY) {
    console.warn("API_KEY environment variable not set for Gemini. AI features will fail.");
}

const genAI = new GoogleGenerativeAI(process.env.API_KEY || '');

export const generateDescription = async (req: express.Request, res: express.Response) => {
    const { productName } = req.body;
    const category = req.body.category || 'Product';

    if (!productName) {
        return res.status(400).json({ message: 'Product name is required.' });
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
            model: "gemini-3-flash-preview",
            generationConfig: {
                temperature: 0.7,
                topP: 1,
                topK: 32,
                maxOutputTokens: 150,
            }
        });

        const result = await model.generateContent(prompt);
        const description = (result.response.text() ?? '').trim();

        // Log usage
        if (req.user?.currentStoreId) {
            await logAiUsage(req.user.currentStoreId, req.user.id, 'description_generation', { productName, category }, description.slice(0, 100));
        }

        res.status(200).json({ description });
    } catch (error: any) {
        console.error("Error generating description with Gemini API:", error);

        if (error.status === 429 || (error.message && error.message.includes('429'))) {
            return res.status(429).json({ message: 'Daily AI quota exceeded. Please try again later.' });
        }

        res.status(500).json({ message: 'Failed to generate AI description. Please try again.' });
    }
};

// Helper function to analyze if query is about business strategy
function analyzeStrategyIntent(query: string): {
    isStrategyQuestion: boolean;
    strategyType: 'general' | 'growth' | 'marketing' | 'operations' | 'customer' | 'financial' | 'competitive' | null;
} {
    const lowerQuery = query.toLowerCase();

    // Strategy keywords
    const strategyKeywords = ['strategy', 'strategies', 'improve', 'grow', 'growth', 'increase', 'boost', 'enhance', 'better', 'optimize', 'advice', 'recommend', 'suggestion', 'should i', 'how can i', 'how do i', 'ways to', 'tips', 'best practice', 'analyze', 'analysis', 'audit', 'retention', 'churn', 'dead stock', 'margin', 'profit'];
    const marketingKeywords = ['market', 'marketing', 'advertise', 'advertising', 'promote', 'promotion', 'campaign', 'social media', 'brand', 'attract customers', 'reach'];
    const operationsKeywords = ['operation', 'efficiency', 'process', 'streamline', 'automate', 'reduce cost', 'waste', 'productivity'];
    const customerKeywords = ['retention', 'loyalty', 'engage', 'engagement', 'customer service', 'experience', 'satisfaction', 'repeat customer'];
    const financialKeywords = ['pricing', 'price', 'profit', 'revenue', 'cash flow', 'financial', 'reduce expenses'];
    const competitiveKeywords = ['compete', 'competition', 'competitive', 'advantage', 'differentiate', 'stand out'];
    const growthKeywords = ['expand', 'expansion', 'scale', 'new market', 'diversify', 'opportunity', 'opportunities'];

    const isStrategyQuestion = strategyKeywords.some(kw => lowerQuery.includes(kw));

    let strategyType: 'general' | 'growth' | 'marketing' | 'operations' | 'customer' | 'financial' | 'competitive' | null = null;

    if (isStrategyQuestion) {
        if (marketingKeywords.some(kw => lowerQuery.includes(kw))) {
            strategyType = 'marketing';
        } else if (operationsKeywords.some(kw => lowerQuery.includes(kw))) {
            strategyType = 'operations';
        } else if (customerKeywords.some(kw => lowerQuery.includes(kw))) {
            strategyType = 'customer';
        } else if (financialKeywords.some(kw => lowerQuery.includes(kw))) {
            strategyType = 'financial';
        } else if (competitiveKeywords.some(kw => lowerQuery.includes(kw))) {
            strategyType = 'competitive';
        } else if (growthKeywords.some(kw => lowerQuery.includes(kw))) {
            strategyType = 'growth';
        } else {
            strategyType = 'general';
        }
    }

    return { isStrategyQuestion, strategyType };
}

// Helper function to analyze query intent
function analyzeQueryIntent(query: string): {
    needsSales: boolean;
    needsInventory: boolean;
    needsCustomers: boolean;
    needsFinancial: boolean;
    needsOrders: boolean;
    needsReturns: boolean;
    needsProjection: boolean;
    isReportRequest: boolean;
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
    const reportKeywords = ['report', 'export', 'statement', 'pdf', 'excel', 'spreadsheet', 'download', 'csv', 'summary'];

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
    const isReportRequest = reportKeywords.some(kw => lowerQuery.includes(kw));

    return {
        needsSales: salesKeywords.some(kw => lowerQuery.includes(kw)) || lowerQuery.includes('overview') || lowerQuery.includes('snapshot') || needsProjection || isReportRequest,
        needsInventory: inventoryKeywords.some(kw => lowerQuery.includes(kw)) || lowerQuery.includes('overview') || lowerQuery.includes('snapshot') || isReportRequest,
        needsCustomers: customerKeywords.some(kw => lowerQuery.includes(kw)) || isReportRequest,
        needsFinancial: financialKeywords.some(kw => lowerQuery.includes(kw)) || isReportRequest,
        needsOrders: orderKeywords.some(kw => lowerQuery.includes(kw)) || isReportRequest,
        needsReturns: returnKeywords.some(kw => lowerQuery.includes(kw)) || isReportRequest,
        needsProjection,
        isReportRequest,
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
            COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total, 
            COUNT(*) as count,
            COALESCE(AVG((subtotal - COALESCE(discount, 0))), 0) as avg_value,
            SUM(CASE WHEN channel = 'online' THEN (subtotal - COALESCE(discount, 0)) ELSE 0 END) as online_total,
            SUM(CASE WHEN channel = 'pos' THEN (subtotal - COALESCE(discount, 0)) ELSE 0 END) as pos_total
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") = $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, today]
    );

    // Week comparison
    const weekSales = await db.query(
        `SELECT 
            COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, weekAgo]
    );

    // Month-to-date sales
    const monthSales = await db.query(
        `SELECT 
            COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, monthStart]
    );

    // Previous month for comparison
    const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().split('T')[0];
    const prevMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().split('T')[0];
    const prevMonthSales = await db.query(
        `SELECT 
            COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled' AND DATE("timestamp") <= $3`,
        [storeId, prevMonthStart, prevMonthEnd]
    );

    // Top products by revenue
    const topProducts = await db.query(
        `SELECT 
            p.name,
            COALESCE(SUM(si.price_at_sale * (si.quantity - si.returned_quantity) * COALESCE(1 - COALESCE(s.discount, 0) / NULLIF(s.subtotal, 0), 1)), 0) as revenue,
            COALESCE(SUM(si.quantity - si.returned_quantity), 0) as units_sold
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
            -- Stock at cost, matching the balance sheet and every other
            -- inventory total. The old price * 0.6 fallback invented a cost for
            -- products that have none, so the AI quoted a figure no other
            -- screen showed.
            COALESCE(SUM(stock * COALESCE(cost_price, 0)), 0) as inventory_value,
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

async function getBusinessStrategyContext(storeId: string) {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const threeMonthsAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sixMonthsAgo = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get recent sales trends (Last 30 days)
    const recentSales = await db.query(
        `SELECT COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total, COUNT(*) as count, COALESCE(AVG((subtotal - COALESCE(discount, 0))), 0) as aov
         FROM sales WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, monthAgo]
    );

    // Previous period for AOV comparison (30-60 days ago)
    const prevMonthSales = await db.query(
        `SELECT COALESCE(AVG((subtotal - COALESCE(discount, 0))), 0) as aov
         FROM sales WHERE store_id = $1 AND DATE("timestamp") >= $2 AND DATE("timestamp") < $3 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, threeMonthsAgo, monthAgo] // Using 3 months window roughly for trend or just simplified prev month
    );

    // Get three-month sales for larger trend analysis
    const threeMonthSales = await db.query(
        `SELECT COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, threeMonthsAgo]
    );

    // Top products (visual check remains same)
    const topProducts = await db.query(
        `SELECT p.name, COALESCE(SUM(si.quantity), 0) as units_sold
         FROM sale_items si
         JOIN products p ON si.product_id = p.id
         JOIN sales s ON si.sale_id = s.transaction_id
         WHERE si.store_id = $1 AND DATE(s."timestamp") >= $2
         GROUP BY p.id, p.name
         ORDER BY units_sold DESC LIMIT 3`,
        [storeId, monthAgo]
    );

    // Inventory health - Extended
    const inventoryHealth = await db.query(
        `SELECT 
            COUNT(CASE WHEN stock <= COALESCE(reorder_point, 10) THEN 1 END) as low_stock_count,
            COUNT(*) as total_products,
            COALESCE(SUM(stock * COALESCE(cost_price, 0)), 0) as inventory_value
         FROM products WHERE store_id = $1 AND status = 'active'`,
        [storeId]
    );

    // Dead Stock Candidates (No sales in 90 days but has stock)
    const deadStock = await db.query(
        `SELECT COUNT(*) as count
         FROM products p
         WHERE p.store_id = $1 
         AND p.stock > 0
         AND p.id NOT IN (
            SELECT DISTINCT product_id 
            FROM sale_items si 
            JOIN sales s ON si.sale_id = s.transaction_id 
            WHERE s.store_id = $1 AND DATE(s."timestamp") >= $2
         )`,
        [storeId, threeMonthsAgo]
    );

    // Customer growth
    const customerGrowth = await db.query(
        `SELECT COUNT(*) as new_customers FROM customers 
         WHERE store_id = $1 AND DATE(created_at) >= $2`,
        [storeId, monthAgo]
    );

    // Customer Retention Logic (Simplified Proxy)
    // Who shopped 3-6 months ago vs who returned in last 3 months
    const retentionQuery = await db.query(
        `WITH old_customers AS (
            SELECT DISTINCT customer_id FROM sales 
            WHERE store_id = $1 AND DATE("timestamp") >= $2 AND DATE("timestamp") < $3 AND customer_id IS NOT NULL
         ),
         returning_customers AS (
            SELECT DISTINCT customer_id FROM sales 
            WHERE store_id = $1 AND DATE("timestamp") >= $3 AND customer_id IN (SELECT customer_id FROM old_customers)
         )
         SELECT 
            (SELECT COUNT(*) FROM old_customers) as base_count,
            (SELECT COUNT(*) FROM returning_customers) as returned_count`,
        [storeId, sixMonthsAgo, threeMonthsAgo]
    );

    // Churn Risk (High value customers who haven't shopped in 60 days)
    const churnRisk = await db.query(
        `SELECT COUNT(DISTINCT s.customer_id) as count
         FROM sales s
         JOIN customers c ON s.customer_id = c.id
         WHERE s.store_id = $1 
         AND s.total > 50 
         AND s.customer_id NOT IN (
            SELECT customer_id FROM sales WHERE store_id = $1 AND DATE("timestamp") >= $2
         )`,
        [storeId, new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]]
    );

    // Calculate trends
    const monthRevenue = parseFloat(recentSales.rows[0].total || 0);
    const threeMonthRevenue = parseFloat(threeMonthSales.rows[0].total || 0);
    const avgMonthlyRevenue = threeMonthRevenue / 3;
    const revenueGrowth = avgMonthlyRevenue > 0 ? ((monthRevenue - avgMonthlyRevenue) / avgMonthlyRevenue * 100) : 0;

    const currentAOV = parseFloat(recentSales.rows[0].aov || 0);
    const prevAOV = parseFloat(prevMonthSales.rows[0].aov || 0);
    const aovTrend = prevAOV > 0 ? ((currentAOV - prevAOV) / prevAOV * 100).toFixed(1) + '%' : '0%';

    const baseCust = parseInt(retentionQuery.rows[0].base_count || '0');
    const retCust = parseInt(retentionQuery.rows[0].returned_count || '0');
    const retentionRate = baseCust > 0 ? ((retCust / baseCust) * 100).toFixed(1) : '0';

    return {
        recentPerformance: {
            monthRevenue,
            transactionCount: recentSales.rows[0].count,
            revenueGrowth: revenueGrowth.toFixed(1),
            avgOrderValue: currentAOV.toFixed(2),
            aovTrend: aovTrend
        },
        topProducts: topProducts.rows,
        inventoryHealth: {
            ...inventoryHealth.rows[0],
            dead_stock_candidates: deadStock.rows[0].count
        },
        customerGrowth: customerGrowth.rows[0].new_customers,
        customerRetention: {
            retentionRate,
            churnRiskCount: churnRisk.rows[0].count
        }
    };
}

async function analyzeAnomalies(storeId: string) {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const prevWeekStart = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Revenue Anomaly
    const revenueQuery = await db.query(
        `WITH current_week AS (
            SELECT COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as rev FROM sales WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'
        ),
        previous_week AS (
            SELECT COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as rev FROM sales WHERE store_id = $1 AND DATE("timestamp") >= $3 AND DATE("timestamp") < $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'
        )
        SELECT (SELECT rev FROM current_week) as current, (SELECT rev FROM previous_week) as previous`,
        [storeId, weekAgo, prevWeekStart]
    );

    const anomalies: string[] = [];
    const revCurr = parseFloat(revenueQuery.rows[0].current);
    const revPrev = parseFloat(revenueQuery.rows[0].previous);

    if (revPrev > 0 && revCurr < revPrev * 0.5) {
        anomalies.push(`CRITICAL: Revenue dropped by ${((1 - revCurr / revPrev) * 100).toFixed(1)}% compared to last week.`);
    }

    // Top Product anomaly
    const topProductAnomaly = await db.query(
        `WITH last_sales AS (
            SELECT si.product_id, SUM(si.quantity) as qty
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.transaction_id AND si.store_id = s.store_id
            WHERE si.store_id = $1 AND DATE(s."timestamp") >= $2
            GROUP BY si.product_id
            ORDER BY qty DESC LIMIT 1
        ),
        prev_sales AS (
            SELECT si.product_id, SUM(si.quantity) as qty
            FROM sale_items si
            JOIN sales s ON si.sale_id = s.transaction_id AND si.store_id = s.store_id
            WHERE si.store_id = $1 AND DATE(s."timestamp") >= $3 AND DATE(s."timestamp") < $2
            GROUP BY si.product_id
        )
        SELECT p.name, ls.qty as current_qty, ps.qty as prev_qty
        FROM last_sales ls
        JOIN products p ON ls.product_id = p.id
        LEFT JOIN prev_sales ps ON ls.product_id = ps.product_id`,
        [storeId, weekAgo, prevWeekStart]
    );

    if (topProductAnomaly.rows.length > 0) {
        const row = topProductAnomaly.rows[0];
        if (row.prev_qty > 0 && row.current_qty < row.prev_qty * 0.4) {
            anomalies.push(`WARNING: Your top seller "${row.name}" sales dropped by ${((1 - row.current_qty / row.prev_qty) * 100).toFixed(1)}%.`);
        }
    }

    return anomalies;
}

async function getProjectionContext(storeId: string, goalAmount?: number) {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Get month-to-date sales
    const monthSales = await db.query(
        `SELECT 
            COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, monthStart]
    );

    // Get last 30 days for comparison
    const last30Days = await db.query(
        `SELECT 
            COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
        [storeId, monthAgo]
    );

    // Get last 7 days
    const last7Days = await db.query(
        `SELECT 
            COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total,
            COUNT(*) as count
         FROM sales 
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
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
        `SELECT COALESCE(SUM((subtotal - COALESCE(discount, 0))), 0) as total
         FROM sales
         WHERE store_id = $1 AND DATE("timestamp") >= $2 AND DATE("timestamp") < $3
           AND fulfillment_status IS DISTINCT FROM 'cancelled'`,
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


// Helper for SuperAdmin Global Context
async function getGlobalContext() {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];

    // Platform Revenue (Subscriptions)
    const subRevenue = await db.query(
        `SELECT 
            COALESCE(SUM(amount), 0) as total_revenue,
            (SELECT COALESCE(SUM(amount), 0) FROM subscription_payments WHERE DATE(paid_at) >= $1) as month_revenue
         FROM subscription_payments`,
        [monthStart]
    );

    // Platform Metrics (Stores & Users)
    const metrics = await db.query(`
        SELECT 
            (SELECT COUNT(*) FROM stores) as total_stores,
            (SELECT COUNT(*) FROM stores WHERE status = 'active') as active_stores,
            (SELECT COUNT(*) FROM users) as total_users,
            (SELECT COUNT(*) FROM stores WHERE DATE(created_at) >= $1) as new_stores_month
        `, [monthStart]
    );

    // Global GMV (All Stores Sales)
    const gmv = await db.query(`
        SELECT 
            COALESCE(SUM(total), 0) as total_gmv,
            (SELECT COALESCE(SUM(total), 0) FROM sales WHERE DATE("timestamp") >= $1) as month_gmv
        FROM sales`,
        [monthStart]
    );

    return {
        revenue: {
            total: parseFloat(subRevenue.rows[0].total_revenue || 0),
            month: parseFloat(subRevenue.rows[0].month_revenue || 0)
        },
        platform: {
            totalStores: parseInt(metrics.rows[0].total_stores || 0),
            activeStores: parseInt(metrics.rows[0].active_stores || 0),
            totalUsers: parseInt(metrics.rows[0].total_users || 0),
            newStoresMonth: parseInt(metrics.rows[0].new_stores_month || 0)
        },
        gmv: {
            total: parseFloat(gmv.rows[0].total_gmv || 0),
            month: parseFloat(gmv.rows[0].month_gmv || 0)
        }
    };
}

// SuperAdmin Platform Insight Generation
export const getPlatformInsight = async (req: express.Request, res: express.Response) => {
    try {
        const user = req.user;
        if (user?.role !== 'superadmin') {
            return res.status(403).json({ message: 'Unauthorized. SuperAdmin access required.' });
        }

        if (!process.env.API_KEY) {
            return res.status(500).json({ message: 'AI service is not configured.' });
        }

        const globalContext = await getGlobalContext();

        const prompt = `You are "SalePilot Core", the platform intelligence.
        Provide a friendly, professional, and slightly optimistic 1-2 sentence summary of the platform's health for the SuperAdmin.
        
        CURRENT DATA:
        - Active Stores: ${globalContext.platform.activeStores} / ${globalContext.platform.totalStores}
        - SaaS Revenue (This Month): $${globalContext.revenue.month.toFixed(2)}
        - Global GMV (This Month): $${globalContext.gmv.month.toFixed(2)}
        
        GOAL:
        - Summarize these metrics into a single, cohesive, engaging statement.
        - Focus on growth and platform stability.
        - Keep it under 200 characters.
        - Do not use markdown bolding or special characters.
        
        Example: "Good day, Admin. Our active store count is up 5% this week, reflecting a healthy 12% growth in global GMV across the network."
        `;

        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 100,
            }
        });

        const result = await model.generateContent(prompt);
        const insight = (result.response.text() ?? '').trim().replace(/\*/g, '');

        // Log usage (System level)
        if (user.role === 'superadmin') {
            await logAiUsage('system', user.id, 'platform_insight', {}, insight.slice(0, 100));
        }

        res.status(200).json({ insight });
    } catch (error: any) {
        console.error("Error generating platform insight:", error);
        if (error.status === 429 || (error.message && error.message.includes('429'))) {
            return res.status(429).json({
                message: 'Daily AI quota exceeded',
                insight: "Daily AI quota reached. Standard platform metrics indicate stable performance across all regions."
            });
        }
        res.status(500).json({ insight: "Platform metrics are stable. Real-time analysis suggests a positive trend in global commerce engagement." });
    }
};

export const handleChat = async (req: express.Request, res: express.Response) => {
    try {
        const { query, context, history } = req.body;
        const user = req.user;
        const storeId = user?.currentStoreId;
        const currencySymbol = context?.currency?.symbol || '$';
        const currencyCode = context?.currency?.code || 'USD';

        if (!query) return res.status(400).json({ message: 'Query is required' });

        // Allow SuperAdmin to proceed without storeId
        if (!storeId && user?.role !== 'superadmin') {
            return res.status(400).json({ message: 'Store context is required' });
        }

        // Premium gate: the AI Business Assistant is a paid add-on (modular
        // packaging). Superadmin/platform chat is exempt. Mirrors sms.controller.
        if (storeId && user?.role !== 'superadmin' && !(await isModuleEnabled(storeId, MODULES.AI_ASSISTANT))) {
            return res.status(402).json({
                message: 'The AI Business Assistant is a premium add-on. Upgrade your plan to unlock it.',
                module: MODULES.AI_ASSISTANT,
            });
        }

        if (!process.env.API_KEY) {
            return res.status(500).json({ message: 'AI service is not configured on the server.' });
        }

        // ==========================================
        // SUPERADMIN / PLATFORM LEVEL CHAT
        // ==========================================
        if (user?.role === 'superadmin' && !storeId) {
            const globalContext = await getGlobalContext();

            const systemPrompt = `You are "SalePilot Core", the Central Intelligence for the SaaS Platform.
            You are speaking to a SuperAdmin (${user.name}).
            
            PLATFORM STATUS (REAL-TIME):
            - Active Stores: ${globalContext.platform.activeStores} / ${globalContext.platform.totalStores} Total
            - Total Users: ${globalContext.platform.totalUsers}
            - New Stores (This Month): ${globalContext.platform.newStoresMonth}
            
            FINANCIALS (SaaS Revenue):
            - Total Revenue: $${globalContext.revenue.total.toFixed(2)}
            - This Month: $${globalContext.revenue.month.toFixed(2)}
            
            GLOBAL GMV (Aggregate Merchants Sales):
            - Total Processed: $${globalContext.gmv.total.toFixed(2)}
            - This Month: $${globalContext.gmv.month.toFixed(2)}
            
            USER QUESTION: "${query}"
            
            INSTRUCTIONS:
            - Provide high-level strategic insights about the platform's health.
            - Focus on growth, revenue, and system scale.
            - If asked about specific store details, advise them to switch to that store's context.
            - Be concise, professional, data-driven, and "efficient".`;

            const model = genAI.getGenerativeModel({
                model: "gemini-3-flash-preview",
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 2000,
                }
            });

            const result = await model.generateContent(systemPrompt);
            const responseText = result.response.text();

            // Log usage (System level for SuperAdmin)
            await logAiUsage('system', user.id, 'superadmin_chat', { query }, responseText.slice(0, 100));

            return res.json({ response: responseText });
        }

        // Ensure storeId is defined for subsequent store-specific logic
        if (!storeId) {
            return res.status(400).json({ message: 'Store context is required' });
        }


        // Check if this is a strategy question first
        const strategyIntent = analyzeStrategyIntent(query);

        if (strategyIntent.isStrategyQuestion) {
            // Handle business strategy questions
            const strategyContext = await getBusinessStrategyContext(storeId);
            const anomalies = await analyzeAnomalies(storeId);

            const strategyPrompt = `You are "Salepilot Intelligence", a tier-1 business strategist.
            
            REASONING PROTOCOL:
            1. Analyze the DATA provided below.
            2. Identify hidden correlations (e.g., "Customer retention is high but AOV is low").
            3. Detect anomalies and risks.
            4. Formulate a multi-step plan.
            
            YOUR THINKING PROCESS:
            Before giving your final response, you MUST wrap your internal monologue/reasoning in <THINKING> tags. In this section, analyze the metrics, calculate ratios, and weigh different strategies.
            
            CURRENT DATA:
            Store Currency: ${currencyCode} (${currencySymbol})
            
            METRICS:
            - MTD Revenue: ${currencySymbol}${strategyContext.recentPerformance.monthRevenue.toFixed(2)} (${strategyContext.recentPerformance.transactionCount} txns)
            - Growth vs 3M Avg: ${strategyContext.recentPerformance.revenueGrowth}%
            - AOV: ${currencySymbol}${strategyContext.recentPerformance.avgOrderValue} (Trend: ${strategyContext.recentPerformance.aovTrend})
            - Inventory Risk: ${strategyContext.inventoryHealth.low_stock_count} critical, ${strategyContext.inventoryHealth.dead_stock_candidates} dead stock
            - Customer Retention: ${strategyContext.customerRetention.retentionRate}%
            - Churn Risk: ${strategyContext.customerRetention.churnRiskCount} customers
            
            DETECTED ANOMALIES:
            ${anomalies.join('\n') || 'None detected.'}
            
            USER QUESTION: "${query}"
            
            OUTPUT STRUCTURE:
            1. <THINKING>...</THINKING> (Your internal reasoning)
            2. **Executive Summary**: Direct, blunt answer or key insight.
            3. **Deep Dive**: Analysis using the specific metrics above.
            4. **Actionable Roadmap**: 3 prioritized "SalesPilot Missions" (actions they can take in the app).`;

            const model = genAI.getGenerativeModel({
                model: "gemini-3-flash-preview",
                generationConfig: {
                    temperature: 0.7,
                    maxOutputTokens: 8192,
                }
            });

            const result = await model.generateContent(strategyPrompt);
            const responseText = result.response.text();

            // Log usage
            await logAiUsage(storeId, user.id, 'strategic_chat', { query }, responseText.slice(0, 100));

            return res.json({ response: responseText });
        }

        // Analyze what data the user is asking for (original data-specific queries)
        const intent = analyzeQueryIntent(query);

        // Gather only the necessary context based on query intent
        const contextParts: string[] = [];

        if (intent.needsSales) {
            const salesData = await getSalesContext(storeId, intent.timeframe);
            contextParts.push(`
SALES DATA (Currency: ${currencyCode}):
- Today: ${currencySymbol}${parseFloat(salesData.today.total || 0).toFixed(2)} from ${salesData.today.count} transactions (avg: ${currencySymbol}${parseFloat(salesData.today.avg_value || 0).toFixed(2)})
- This Week: ${currencySymbol}${parseFloat(salesData.week.total || 0).toFixed(2)} from ${salesData.week.count} transactions
- This Month: ${currencySymbol}${parseFloat(salesData.month.total || 0).toFixed(2)} from ${salesData.month.count} transactions
- Previous Month: ${currencySymbol}${parseFloat(salesData.prevMonth.total || 0).toFixed(2)} from ${salesData.prevMonth.count} transactions
- Channel Split: Online ${currencySymbol}${parseFloat(salesData.today.online_total || 0).toFixed(2)} | POS ${currencySymbol}${parseFloat(salesData.today.pos_total || 0).toFixed(2)}
- Top Products: ${salesData.topProducts.map(p => `${p.name} (${currencySymbol}${parseFloat(p.revenue).toFixed(2)}, ${p.units_sold} units)`).join(', ') || 'No sales data'}
- Payment Methods: ${salesData.paymentMethods.map(pm => `${pm.method}: ${currencySymbol}${parseFloat(pm.total).toFixed(2)}`).join(', ') || 'No payment data'}
            `);
        }

        if (intent.needsProjection) {
            const projectionData = await getProjectionContext(storeId, intent.goalAmount);
            let projectionText = `
SALES PROJECTIONS & FORECASTS (Currency: ${currencyCode}):
- Month-to-Date: ${currencySymbol}${projectionData.monthToDate.total.toFixed(2)} (${projectionData.monthToDate.daysElapsed} days elapsed)
- Average Daily Revenue: ${currencySymbol}${projectionData.averages.daily.toFixed(2)} (this month) | ${currencySymbol}${projectionData.averages.daily7.toFixed(2)} (last 7 days) | ${currencySymbol}${projectionData.averages.daily30.toFixed(2)} (last 30 days)
- Average Weekly Revenue: ${currencySymbol}${projectionData.averages.weekly.toFixed(2)}
- Average Monthly Revenue: ${currencySymbol}${projectionData.averages.monthly.toFixed(2)}
- Projected Month-End Revenue: ${currencySymbol}${projectionData.projectedMonthEnd.toFixed(2)}
- Growth Rate: ${projectionData.growthRate > 0 ? '+' : ''}${projectionData.growthRate.toFixed(1)}% (7-day vs previous 23-day average)`;

            if (projectionData.goalProjection) {
                projectionText += `\n- Goal: ${currencySymbol}${projectionData.goalProjection.goalAmount.toLocaleString()}
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
- Inventory Value: ${currencySymbol}${parseFloat(inventoryData.summary.inventory_value || 0).toFixed(2)}
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
- Total Store Credit Outstanding: ${currencySymbol}${parseFloat(customerData.summary.total_store_credit || 0).toFixed(2)}
- Top Customers: ${customerData.topCustomers.map(c => `${c.name} (${currencySymbol}${parseFloat(c.total_spent || 0).toFixed(2)}, ${c.purchase_count} purchases)`).join(', ') || 'No customer data'}
            `);
        }

        if (intent.needsFinancial) {
            const financialData = await getFinancialContext(storeId);
            contextParts.push(`
FINANCIAL DATA (Last 30 Days):
- Revenue: ${currencySymbol}${financialData.revenue.toFixed(2)}
- COGS: ${currencySymbol}${financialData.cogs.toFixed(2)}
- Gross Profit: ${currencySymbol}${financialData.grossProfit.toFixed(2)}
- Profit Margin: ${financialData.profitMargin}
- Accounts Receivable: ${currencySymbol}${financialData.accountsReceivable.toFixed(2)}
            `);
        }

        if (intent.needsOrders) {
            const ordersData = await getOrdersContext(storeId);
            contextParts.push(`
PURCHASE ORDERS:
- Pending Orders: ${ordersData.pendingOrders.map(po => `PO ${po.po_number} - ${po.supplier_name} (${currencySymbol}${parseFloat(po.total).toFixed(2)}, ${po.status})`).join(', ') || 'No pending orders'}
            `);
        }

        if (intent.needsReturns) {
            const returnsData = await getReturnsContext(storeId);
            contextParts.push(`
RETURNS DATA (Last 30 Days):
- Total Returns: ${returnsData.summary.return_count}
- Total Refunded: ${currencySymbol}${parseFloat(returnsData.summary.total_refunded || 0).toFixed(2)}
- Most Returned: ${returnsData.topReturned.map(r => `${r.product_name} (${parseFloat(r.return_count).toFixed(0)}x)`).join(', ') || 'No returns'}
            `);
        }

        // If no specific intent detected, provide overview
        if (contextParts.length === 0) {
            const salesData = await getSalesContext(storeId, 'today');
            const inventoryData = await getInventoryContext(storeId);
            contextParts.push(`
QUICK OVERVIEW (Currency: ${currencyCode}):
- Today's Sales: ${currencySymbol}${parseFloat(salesData.today.total || 0).toFixed(2)} (${salesData.today.count} transactions)
- Low Stock Items: ${inventoryData.summary.low_stock_count}
            `);
        }

        // Format chat history for the AI
        const historyContext = history && history.length > 0
            ? history.map((msg: any) => `${msg.role.toUpperCase()}: ${msg.content}`).join('\n')
            : "No previous conversation.";

        // Construct enhanced AI prompt
        const systemContext = `You are "SalePilot AI Assistant", a warm, knowledgeable business advisor.
        
        REASONING PROTOCOL:
        1. Parse the BUSINESS DATA provided.
        2. Identify key trends, anomalies, or growth opportunities.
        3. Consider the CONVERSATION HISTORY for context and follow-up intent.
        4. Formulate a conversational, insightful, and data-backed response.
        
        YOUR THINKING PROCESS:
        You MUST wrap your internal reasoning in <THINKING> tags before the final response.
        
        Current Date: ${new Date().toISOString().split('T')[0]}
        Store ID: ${storeId}
        
        CONVERSATION HISTORY:
        ${historyContext}

        BUSINESS DATA:
        ${contextParts.join('\n')}
        
        USER QUESTION: "${query}"
        
        RESPONSE FORMATTING (CRITICAL — follow strictly):
        - Use **## headings** to organize sections (e.g., "## Sales Overview", "## Recommendations")
        - Use **bullet lists** (- item) for data points, never dump raw numbers in paragraphs
        - Use **bold** for key metrics and numbers (e.g., **${currencySymbol}1,234.56**)
        - When comparing data (channels, products, time periods), use a **markdown table**
        - Keep responses concise: 2-4 short sections max, no walls of text
        - Use short paragraphs (1-2 sentences each)
        
        TONE & STYLE:
        - Respond like a warm, professional business advisor — friendly but data-driven
        - Be concise and direct — get to the insight quickly
        - Format numbers clearly with ${currencySymbol}
        - Always look for ways to help the user grow their business
        - End with one brief, actionable tip or a smart follow-up question
        
        SPECIAL CASES:
        - If the user asks for a report, statement, or export (detected: ${intent.isReportRequest}), include the raw data in a structured JSON format at the end, wrapped in <REPORT_DATA> tags with 'title', 'headers' (array), and 'rows' (array of arrays).
        - After your answer, ask ONE concise follow-up question that helps the user explore deeper.`;

        // Call AI with enhanced context
        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 4096,
            }
        });

        const result = await model.generateContent(systemContext);
        const responseText = result.response.text();

        // Log usage
        await logAiUsage(storeId, user.id, 'standard_chat', { query }, responseText.slice(0, 100));

        res.json({ response: responseText, intent: intent });

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

export const generatePoster = async (req: express.Request, res: express.Response) => {
    // Enhanced request body with Zambia-specific Brand Agent fields
    const {
        productName,
        price,
        storeName,
        tone,
        customText,
        format,
        shopName,      // New: Brand Agent shop name field
        offer,         // New: Offer/promotion (e.g., "20% off", "12 ZMW")
        currency       // New: Currency code (default ZMW for Zambia)
    } = req.body;
    const category = req.body.category || 'Product';
    const currencySymbol = currency === 'ZMW' ? 'ZMW' : currency === 'USD' ? '$' : currency || 'ZMW';

    // Use shopName if provided, otherwise fall back to storeName
    const displayShopName = shopName || storeName || 'Our Store';

    if (!productName) {
        return res.status(400).json({ message: 'Product name is required.' });
    }

    if (!process.env.API_KEY) {
        return res.status(500).json({ message: 'AI service is not configured on the server.' });
    }

    try {
        // Step 1: Generate a Visual Prompt using Gemini 3 Pro Preview (upgraded from 1.5 Flash)
        // This model provides superior prompt refinement for the Brand Agent workflow
        const promptModel = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview", // Using verified latest model
            generationConfig: {
                temperature: 0.85,
                maxOutputTokens: 300,
            }
        });

        // Enhanced prompt with Zambia-specific context for Brand Agent
        const prompt = `You are a world-class cinematic poster designer specializing in retail marketing for African markets.
          Generate a detailed visual description for an AI image generator to create a premium, high-resolution retail poster.
          
          === BRAND DETAILS ===
          Shop Name: "${displayShopName}"
          Product: "${productName}"
          Category: "${category}"
          Price: "${currencySymbol} ${price}"
          ${offer ? `Special Offer: "${offer}"` : ''}
          Tone/Vibe: "${tone}"
          Marketing Copy: "${customText}"
          Aspect Ratio: ${format === 'portrait' ? '9:16 (vertical for mobile/social media)' : '1:1 (square for Instagram)'}
          
          === DESIGN REQUIREMENTS ===
          - Visual style: "cinematic", "photorealistic", "commercial quality", "print-ready 2K resolution"
          - Include the shop name "${displayShopName}" as large, bold, professional 3D text at the top
          - Display pricing with "${currencySymbol}" currency symbol prominently
          ${offer ? `- Feature the offer "${offer}" in an eye-catching badge or banner` : ''}
          - Background inspiration: vibrant Zambian/African market atmosphere, sunny street scene, or modern retail space
          - Lighting: cinematic volumetric lighting, rim light, natural African sunlight
          - Composition: product in foreground with professional studio lighting, text overlay areas clearly defined
          
          Keep the description highly descriptive and focused on visual elements (max 100 words).
          Output ONLY the visual prompt for the image generator, nothing else.
        `;

        const promptResult = await promptModel.generateContent(prompt);
        const visualPrompt = (promptResult.response.text() ?? '').trim();

        // Step 2: Try to generate image using Imagen (with fallback)
        let base64Image: string | null = null;
        let usedModel = "canvas-fallback";

        try {
            // Attempt Imagen 4.0 generation (Nano Banana Pro)
            const imageModel = genAI.getGenerativeModel({ model: "imagen-4.0-generate-001" });

            const enhancedImagePrompt = `${visualPrompt}

CRITICAL TEXT ELEMENTS TO RENDER ACCURATELY:
- Shop Name: "${displayShopName}" (large, prominent, 3D text)
- Price: "${currencySymbol} ${price}" (clear, readable)
${offer ? `- Offer: "${offer}" (badge/banner style)` : ''}
${customText ? `- Tagline: "${customText}"` : ''}

GENERATION PARAMETERS:
- Aspect Ratio: ${format === 'portrait' ? "9:16" : "1:1"}
- Number of Images: 1`;

            const result = await imageModel.generateContent({
                contents: [{ role: 'user', parts: [{ text: enhancedImagePrompt }] }],
                // @ts-ignore - GenerationConfig for image models
                generationConfig: {
                    // aspect_ratio and number_of_images are not supported in GenerationConfig for this API version
                    // relying on prompt instructions
                } as any
            });

            const responseResponse = await result.response;
            const parts = responseResponse.candidates?.[0]?.content?.parts;
            // Imagen 4/3 usually returns inlineData or a URI.
            const imagePart = parts?.find((p: any) => p.inlineData);

            if (imagePart && imagePart.inlineData) {
                base64Image = `data:${imagePart.inlineData.mimeType};base64,${imagePart.inlineData.data}`;
                usedModel = "nano-banana-pro"; // Updated internal name reference
            }

            // Log success for debugging
            console.log("Imagen generation successful");
        } catch (imagenError: any) {
            console.warn("Imagen generation failed, using canvas fallback:", imagenError.message);
            // Continue to fallback - return visual prompt for canvas-based generation
        }

        // Return response - if base64Image is null, frontend will use canvas fallback
        res.status(200).json({
            imageUrl: base64Image, // null triggers frontend canvas fallback
            visualPrompt,
            model: usedModel,
            shopName: displayShopName,
            offer: offer || null,
            currency: currencySymbol,
            // Fallback hint for frontend
            useFallback: base64Image === null
        });

        // Log usage if storeId is available
        const storeId = req.user?.currentStoreId;
        if (storeId) {
            await logAiUsage(storeId, req.user!.id, 'poster_generation', { productName, format }, visualPrompt.slice(0, 50));
        }
    } catch (error: any) {
        console.error("Error generating AI poster:", error);

        // If even the prompt generation failed, return error
        let errorMessage = 'Failed to generate poster.';
        if (error.message?.includes('400')) errorMessage += ' (Invalid parameters)';
        if (error.message?.includes('403')) errorMessage += ' (API Key permission denied)';
        if (error.message?.includes('429')) errorMessage += ' (Quota exceeded - try again later)';

        res.status(500).json({
            message: errorMessage,
            detail: error.message
        });
    }
};

// Removed proxyImage as we are now using native generation returning Base64
// We can delete the export or just leave it empty/warning effectively removing usage.
export const proxyImage = async (req: express.Request, res: express.Response) => {
    res.status(410).send("Proxy deprecated. Using native Google Imagen.");
};

// ============================================================
// SUPERADMIN AI FUNCTIONS - Platform-Wide Intelligence
// ============================================================

async function getSuperAdminPlatformContext() {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Total stores and status breakdown
    const storeStats = await db.query(
        `SELECT 
            COUNT(*) as total,
            COUNT(CASE WHEN status = 'active' THEN 1 END) as active,
            COUNT(CASE WHEN status = 'inactive' THEN 1 END) as inactive,
            COUNT(CASE WHEN status = 'suspended' THEN 1 END) as suspended,
            COUNT(CASE WHEN subscription_status = 'trial' THEN 1 END) as on_trial,
            COUNT(CASE WHEN subscription_status = 'active' THEN 1 END) as subscribed,
            COUNT(CASE WHEN subscription_status = 'past_due' THEN 1 END) as past_due
         FROM stores`
    );

    // Platform-wide revenue (today, week, month)
    const revenueToday = await db.query(
        `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM sales WHERE DATE("timestamp") = $1`,
        [today]
    );

    const revenueWeek = await db.query(
        `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM sales WHERE DATE("timestamp") >= $1`,
        [weekAgo]
    );

    const revenueMonth = await db.query(
        `SELECT COALESCE(SUM(total), 0) as total, COUNT(*) as count FROM sales WHERE DATE("timestamp") >= $1`,
        [monthAgo]
    );

    // Top performing stores this month
    // Top performing stores this month
    const topStores = await db.query(
        `SELECT 
            st.id,
            st.name as store_name,
            COALESCE(SUM(s.total), 0) as revenue,
            COUNT(*) as transactions
         FROM sales s
         JOIN stores st ON s.store_id = st.id
         WHERE DATE(s."timestamp") >= $1
         GROUP BY st.id, st.name
         ORDER BY revenue DESC
         LIMIT 5`,
        [monthAgo]
    );

    // New stores this month
    const newStores = await db.query(
        `SELECT COUNT(*) as count FROM stores WHERE DATE(created_at) >= $1`,
        [monthAgo]
    );

    // Total users across platform
    const userStats = await db.query(
        `SELECT COUNT(*) as total FROM users`
    );

    return {
        stores: storeStats.rows[0],
        revenue: {
            today: { total: parseFloat(revenueToday.rows[0].total || 0), count: revenueToday.rows[0].count },
            week: { total: parseFloat(revenueWeek.rows[0].total || 0), count: revenueWeek.rows[0].count },
            month: { total: parseFloat(revenueMonth.rows[0].total || 0), count: revenueMonth.rows[0].count }
        },
        topStores: topStores.rows,
        newStoresThisMonth: newStores.rows[0].count,
        totalUsers: userStats.rows[0].total
    };
}

async function getSuperAdminStoreHealthContext() {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    // Stores with declining revenue (comparison of recent week vs previous 3 weeks)
    const decliningStores = await db.query(
        `WITH recent_week AS (
            SELECT store_id, COALESCE(SUM(total), 0) as revenue
            FROM sales WHERE DATE("timestamp") >= $1
            GROUP BY store_id
        ),
        prev_weeks AS (
            SELECT store_id, COALESCE(SUM(total), 0) / 3 as avg_revenue
            FROM sales WHERE DATE("timestamp") >= $2 AND DATE("timestamp") < $1
            GROUP BY store_id
        )
        SELECT st.id, st.name, rw.revenue as recent_revenue, pw.avg_revenue as prev_avg,
               CASE WHEN pw.avg_revenue > 0 THEN 
                   ROUND(((rw.revenue - pw.avg_revenue) / pw.avg_revenue * 100)::numeric, 1) 
               ELSE 0 END as change_pct
        FROM stores st
        LEFT JOIN recent_week rw ON st.id = rw.store_id
        LEFT JOIN prev_weeks pw ON st.id = pw.store_id
        WHERE st.status = 'active' 
          AND pw.avg_revenue > 0 
          AND rw.revenue < pw.avg_revenue * 0.7
        ORDER BY change_pct ASC
        LIMIT 5`,
        [weekAgo, monthAgo]
    );

    // Stores at risk (past-due subscriptions, or no activity in 7 days)
    const atRiskStores = await db.query(
        `SELECT st.id, st.name, st.subscription_status, st.status,
                (SELECT MAX(s."timestamp") FROM sales s WHERE s.store_id = st.id) as last_sale
         FROM stores st
         WHERE st.subscription_status = 'past_due'
            OR (st.status = 'active' AND st.id NOT IN (
                SELECT DISTINCT store_id FROM sales WHERE DATE("timestamp") >= $1
            ))
         LIMIT 10`,
        [weekAgo]
    );

    // Recently onboarded stores (last 30 days) with their performance
    const newStorePerformance = await db.query(
        `SELECT st.id, st.name, st.created_at,
                COALESCE(SUM(s.total), 0) as revenue,
                COUNT(s.transaction_id) as transactions
         FROM stores st
         LEFT JOIN sales s ON st.id = s.store_id
         WHERE DATE(st.created_at) >= $1
         GROUP BY st.id, st.name, st.created_at
         ORDER BY st.created_at DESC
         LIMIT 10`,
        [monthAgo]
    );

    return {
        decliningStores: decliningStores.rows,
        atRiskStores: atRiskStores.rows,
        newStorePerformance: newStorePerformance.rows
    };
}

async function getSuperAdminRevenueTrendsContext() {
    const today = new Date();
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().split('T')[0];
    const prevMonthStart = new Date(today.getFullYear(), today.getMonth() - 1, 1).toISOString().split('T')[0];
    const prevMonthEnd = new Date(today.getFullYear(), today.getMonth(), 0).toISOString().split('T')[0];

    // Monthly Recurring Revenue (MRR) from subscriptions
    const mrrData = await db.query(
        `SELECT 
            COUNT(CASE WHEN subscription_status = 'active' THEN 1 END) as active_subscriptions,
            COUNT(CASE WHEN subscription_status = 'trial' THEN 1 END) as trials
         FROM stores WHERE status = 'active'`
    );

    // Subscription tier distribution
    const tierDistribution = await db.query(
        `SELECT 
            COALESCE(subscription_plan, 'free') as plan,
            COUNT(*) as count
         FROM stores
         GROUP BY subscription_plan
         ORDER BY count DESC`
    );

    // Monthly revenue comparison
    const currentMonthRevenue = await db.query(
        `SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE DATE("timestamp") >= $1`,
        [monthStart]
    );

    const prevMonthRevenue = await db.query(
        `SELECT COALESCE(SUM(total), 0) as total FROM sales WHERE DATE("timestamp") >= $1 AND DATE("timestamp") <= $2`,
        [prevMonthStart, prevMonthEnd]
    );

    // Calculate growth rate
    const currentRev = parseFloat(currentMonthRevenue.rows[0].total || 0);
    const prevRev = parseFloat(prevMonthRevenue.rows[0].total || 0);
    const growthRate = prevRev > 0 ? ((currentRev - prevRev) / prevRev * 100).toFixed(1) : '0';

    // Daily revenue trend for the last 7 days
    const dailyTrend = await db.query(
        `SELECT DATE("timestamp") as date, COALESCE(SUM(total), 0) as revenue, COUNT(*) as transactions
         FROM sales
         WHERE DATE("timestamp") >= NOW() - INTERVAL '7 days'
         GROUP BY DATE("timestamp")
         ORDER BY date ASC`
    );

    return {
        mrr: {
            activeSubscriptions: mrrData.rows[0].active_subscriptions,
            trials: mrrData.rows[0].trials
        },
        tierDistribution: tierDistribution.rows,
        monthlyComparison: {
            current: currentRev,
            previous: prevRev,
            growthRate: `${growthRate}%`
        },
        dailyTrend: dailyTrend.rows
    };
}

// Analyze superadmin-specific query intent
function analyzeSuperAdminQueryIntent(query: string): {
    needsPlatformOverview: boolean;
    needsStoreHealth: boolean;
    needsRevenueTrends: boolean;
    needsStoreDetails: boolean;
    isActionRequest: boolean;
} {
    const lowerQuery = query.toLowerCase();

    const platformKeywords = ['platform', 'overview', 'dashboard', 'summary', 'total', 'all stores', 'overall'];
    const healthKeywords = ['health', 'risk', 'declining', 'attention', 'problem', 'issue', 'struggling', 'inactive', 'past due'];
    const revenueKeywords = ['revenue', 'mrr', 'subscription', 'growth', 'trend', 'income', 'money', 'earnings'];
    const storeKeywords = ['store', 'which store', 'top store', 'best store', 'worst store', 'new store'];
    const actionKeywords = ['how to', 'what should', 'recommend', 'improve', 'grow', 'fix', 'strategy', 'action'];

    return {
        needsPlatformOverview: platformKeywords.some(kw => lowerQuery.includes(kw)) || lowerQuery.includes('overview'),
        needsStoreHealth: healthKeywords.some(kw => lowerQuery.includes(kw)),
        needsRevenueTrends: revenueKeywords.some(kw => lowerQuery.includes(kw)),
        needsStoreDetails: storeKeywords.some(kw => lowerQuery.includes(kw)),
        isActionRequest: actionKeywords.some(kw => lowerQuery.includes(kw))
    };
}

export const handleSuperAdminChat = async (req: express.Request, res: express.Response) => {
    try {
        const { query } = req.body;
        const user = req.user;

        if (!query) {
            return res.status(400).json({ message: 'Query is required' });
        }

        if (!process.env.API_KEY) {
            return res.status(500).json({ message: 'AI service is not configured on the server.' });
        }

        // Analyze what data the superadmin is asking for
        const intent = analyzeSuperAdminQueryIntent(query);

        // Gather relevant context
        const contextParts: string[] = [];

        // Always include platform overview for superadmin queries
        const platformContext = await getSuperAdminPlatformContext();
        contextParts.push(`
PLATFORM OVERVIEW:
- Total Stores: ${platformContext.stores.total} (Active: ${platformContext.stores.active}, Inactive: ${platformContext.stores.inactive}, Suspended: ${platformContext.stores.suspended})
- Subscription Status: ${platformContext.stores.subscribed} subscribed, ${platformContext.stores.on_trial} on trial, ${platformContext.stores.past_due} past due
- Total Users: ${platformContext.totalUsers}
- New Stores This Month: ${platformContext.newStoresThisMonth}

PLATFORM REVENUE:
- Today: $${platformContext.revenue.today.total.toFixed(2)} (${platformContext.revenue.today.count} transactions)
- This Week: $${platformContext.revenue.week.total.toFixed(2)} (${platformContext.revenue.week.count} transactions)
- This Month: $${platformContext.revenue.month.total.toFixed(2)} (${platformContext.revenue.month.count} transactions)

TOP PERFORMING STORES (This Month):
${platformContext.topStores.map((s: any, i: number) => `${i + 1}. ${s.store_name}: $${parseFloat(s.revenue).toFixed(2)} (${s.transactions} transactions)`).join('\n') || 'No sales data available'}
        `);

        if (intent.needsStoreHealth || intent.isActionRequest) {
            const healthContext = await getSuperAdminStoreHealthContext();
            contextParts.push(`
STORE HEALTH ANALYSIS:
Declining Stores (revenue down >30% vs previous weeks):
${healthContext.decliningStores.length > 0
                    ? healthContext.decliningStores.map((s: any) => `- ${s.name}: ${s.change_pct}% decline (was $${parseFloat(s.prev_avg).toFixed(2)}/week, now $${parseFloat(s.recent_revenue).toFixed(2)}/week)`).join('\n')
                    : '- No significantly declining stores detected'}

At-Risk Stores (past-due or inactive):
${healthContext.atRiskStores.length > 0
                    ? healthContext.atRiskStores.map((s: any) => `- ${s.name}: ${s.subscription_status} subscription, last sale: ${s.last_sale ? new Date(s.last_sale).toLocaleDateString() : 'Never'}`).join('\n')
                    : '- No at-risk stores detected'}

New Store Performance (Last 30 Days):
${healthContext.newStorePerformance.map((s: any) => `- ${s.name}: $${parseFloat(s.revenue).toFixed(2)} revenue, ${s.transactions} transactions since ${new Date(s.created_at).toLocaleDateString()}`).join('\n') || 'No new stores'}
            `);
        }

        if (intent.needsRevenueTrends) {
            const revenueContext = await getSuperAdminRevenueTrendsContext();
            contextParts.push(`
REVENUE TRENDS:
- Active Subscriptions: ${revenueContext.mrr.activeSubscriptions}
- Free Trials: ${revenueContext.mrr.trials}
- Month-over-Month Growth: ${revenueContext.monthlyComparison.growthRate}
- Current Month: $${revenueContext.monthlyComparison.current.toFixed(2)}
- Previous Month: $${revenueContext.monthlyComparison.previous.toFixed(2)}

Subscription Tier Distribution:
${revenueContext.tierDistribution.map((t: any) => `- ${t.plan}: ${t.count} stores`).join('\n')}

Daily Revenue (Last 7 Days):
${revenueContext.dailyTrend.map((d: any) => `- ${new Date(d.date).toLocaleDateString()}: $${parseFloat(d.revenue).toFixed(2)}`).join('\n')}
            `);
        }

        // Build the prompt
        const systemPrompt = `You are "SalePilot Core Intelligence", the platform's central brain.
        
        REASONING PROTOCOL:
        1. Evaluate platform-wide metrics.
        2. Identify stores needing attention.
        3. Formulate high-level strategic advice.
        
        YOUR THINKING PROCESS:
        You MUST wrap your internal reasoning in <THINKING> tags.
        
        Current Date: ${new Date().toISOString().split('T')[0]}
        Administrator: ${user?.name || 'SuperAdmin'}

        ${contextParts.join('\n')}

        USER QUESTION: "${query}"

        INSTRUCTIONS:
        - Provide high-level, data-driven insights.
        - Highlight anomalies or risks in the store network.
        - Be authoritative yet professional.
        - Use **bolding** for critical data points.`;

        const model = genAI.getGenerativeModel({
            model: "gemini-3-flash-preview",
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 4096,
            }
        });

        const result = await model.generateContent(systemPrompt);
        return res.json({ response: result.response.text() });

    } catch (error: any) {
        console.error("SuperAdmin AI Chat Error:", error);

        if (error.status === 429 || (error.message && error.message.includes('429'))) {
            return res.status(429).json({ message: 'AI quota exceeded. Please try again later.' });
        }

        res.status(500).json({ message: 'Failed to process AI request. Please try again.' });
    }
};

export const getAiUsage = async (req: express.Request, res: express.Response) => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'Store context required' });

    try {
        const storeRes = await db.query('SELECT subscription_plan FROM stores WHERE id = $1', [storeId]);
        const planId = storeRes.rows[0]?.subscription_plan || 'plan_basic';
        const plan = SUBSCRIPTION_PLANS.find(p => p.id === planId) || SUBSCRIPTION_PLANS[0];

        const monthStart = new Date();
        monthStart.setDate(1);
        monthStart.setHours(0, 0, 0, 0);

        const usageRes = await db.query(
            'SELECT COUNT(*) as count FROM ai_usage_logs WHERE store_id = $1 AND created_at >= $2',
            [storeId, monthStart]
        );

        const count = parseInt(usageRes.rows[0].count, 10);

        res.json({
            count,
            limit: plan.aiRequestsLimit,
            remaining: plan.aiRequestsLimit === -1 ? -1 : Math.max(0, plan.aiRequestsLimit - count),
            planName: plan.name
        });
    } catch (error) {
        console.error('Error fetching AI usage:', error);
        res.status(500).json({ message: 'Error fetching AI usage' });
    }
};