import db from '../db_client';
import { sendEmail } from './email.service';
import { generateId } from '../utils/helpers';

/**
 * Automated email engine.
 *
 * Superadmin-configurable transactional emails, stored in the `email_templates`
 * table and rendered with {{variable}} substitution. Replaces the old dead-end
 * pattern where events were written to a Firestore `mail_events` collection that
 * nothing ever consumed — these now render from editable templates and send via
 * the working nodemailer transport (email.service.ts).
 *
 * Each template: enable/disable, editable subject + HTML, and an optional numeric
 * condition (e.g. only email the owner for expenses above a threshold). Links are
 * always built from the real app URL, never a localhost fallback.
 */

export interface EmailTemplateVar {
    name: string;
    description: string;
}

export interface EmailTemplateCondition {
    /** JSON key in the template's `config`. */
    field: string;
    label: string;
    default: number;
}

export interface EmailTemplateDef {
    key: string;
    name: string;
    description: string;
    /** Human label for who receives it (display only). */
    recipient: string;
    subject: string;
    html: string;
    defaultEnabled: boolean;
    variables: EmailTemplateVar[];
    /** Sample values used for the live preview and test sends. */
    sample: Record<string, string | number>;
    /** Optional numeric gate (only LARGE_EXPENSE_RECORDED today). */
    condition?: EmailTemplateCondition;
    /** 'event' = fired by a trigger; 'tip' = sent by the periodic scheduler. */
    category?: 'event' | 'tip';
    /** For tips: an editable "days after signup" timing knob (stored in config). */
    schedule?: EmailTemplateCondition;
}

/** The canonical app URL for links — never the localhost dev fallback. */
export const appUrl = (): string =>
    (process.env.FRONTEND_URL || 'https://www.salepilot.space').replace(/\/+$/, '');

// Money-valued fields are formatted to a grouped 2-decimal string before
// substitution so templates render "1,250.00" rather than "1250".
const MONEY_FIELDS = new Set(['total', 'amount', 'refundAmount', 'totalCost']);

const formatMoney = (n: any): string => {
    const v = typeof n === 'string' ? parseFloat(n) : n;
    if (!Number.isFinite(v)) return String(n ?? '');
    return new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v);
};

/** Deep-links + globals every template can reference. */
const globalContext = (): Record<string, string | number> => {
    const base = appUrl();
    return {
        appUrl: base,
        dashboardUrl: `${base}/dash`,
        posUrl: `${base}/pos`,
        inventoryUrl: `${base}/inv/items`,
        stockTakesUrl: `${base}/inv/stock-takes`,
        ordersUrl: `${base}/pos/history`,
        customersUrl: `${base}/crm/customers`,
        suppliersUrl: `${base}/procure/suppliers`,
        purchaseOrdersUrl: `${base}/procure/orders`,
        teamUrl: `${base}/team`,
        booksUrl: `${base}/books`,
        reportsUrl: `${base}/reports`,
        settingsUrl: `${base}/config`,
        subscriptionUrl: `${base}/subscription`,
        year: new Date().getFullYear(),
    };
};

/** Replace {{ var }} tokens; unknown tokens render empty (never leak "{{x}}"). */
export const renderString = (template: string, ctx: Record<string, any>): string =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => (ctx[key] != null ? String(ctx[key]) : ''));

// ── Shared on-brand wrapper used to GENERATE the default HTML. The stored value
// is the full document, so a superadmin can edit any part of it. Colours, font
// and radii mirror salepilot/DESIGN.md (Velocity POS): deep navy primary,
// vibrant orange for conversion CTAs, Hanken Grotesk, soft corners. ────────────
const NAVY = '#002b6b';          // DESIGN.md primary
const ORANGE = '#ff7f27';        // DESIGN.md secondary-container (conversion CTA)
const INK = '#181c1e';           // DESIGN.md on-surface
const INK_MUTED = '#434651';     // DESIGN.md on-surface-variant
const CANVAS = '#f7fafc';        // DESIGN.md surface / background
const HAIRLINE = '#c4c6d2';      // DESIGN.md outline-variant
const SUBTLE = '#ebeef0';        // DESIGN.md surface-container
// Hanken Grotesk where the client supports web fonts; clean system fallback otherwise.
const FONT = "'Hanken Grotesk','Helvetica Neue',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

const wrap = (opts: { heading: string; intro: string; detailRows?: string; ctaLabel?: string; ctaVar?: string; footnote?: string }) => `
<div style="font-family:${FONT};max-width:600px;margin:0 auto;background:${CANVAS};padding:24px;">
  <div style="background:${NAVY};border-radius:8px 8px 0 0;padding:22px 28px;text-align:center;">
    <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.02em;">Sale<span style="color:${ORANGE};">Pilot</span></span>
  </div>
  <div style="background:#ffffff;padding:32px 28px;border:1px solid ${HAIRLINE};border-top:0;">
    <h1 style="margin:0 0 12px;color:${INK};font-size:24px;font-weight:600;line-height:32px;letter-spacing:-0.01em;">${opts.heading}</h1>
    <p style="margin:0 0 20px;color:${INK_MUTED};font-size:16px;line-height:24px;">${opts.intro}</p>
    ${opts.detailRows ? `<table role="presentation" style="width:100%;border-collapse:separate;border-spacing:0;margin:0 0 24px;background:${CANVAS};border:1px solid ${HAIRLINE};border-radius:8px;overflow:hidden;">${opts.detailRows}</table>` : ''}
    ${opts.ctaLabel && opts.ctaVar ? `<div style="text-align:center;margin:8px 0 4px;"><a href="{{${opts.ctaVar}}}" style="display:inline-block;background:${ORANGE};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;line-height:20px;padding:14px 32px;border-radius:8px;">${opts.ctaLabel}</a></div>` : ''}
    ${opts.footnote ? `<p style="margin:20px 0 0;color:${INK_MUTED};font-size:14px;line-height:20px;">${opts.footnote}</p>` : ''}
  </div>
  <div style="text-align:center;padding:18px;color:${INK_MUTED};font-size:12px;">
    © {{year}} SalePilot · <a href="{{appUrl}}" style="color:${NAVY};text-decoration:none;font-weight:600;">salepilot.space</a>
  </div>
</div>`.trim();

const row = (label: string, valueVar: string, prefix = '') =>
    `<tr><td style="padding:12px 16px;color:${INK_MUTED};font-size:13px;font-weight:500;border-bottom:1px solid ${SUBTLE};">${label}</td><td style="padding:12px 16px;color:${INK};font-size:14px;font-weight:600;text-align:right;border-bottom:1px solid ${SUBTLE};">${prefix}{{${valueVar}}}</td></tr>`;

// ── The 8 default templates ────────────────────────────────────────────────
export const EMAIL_TEMPLATES: EmailTemplateDef[] = [
    {
        key: 'ORDER_CONFIRMATION',
        name: 'Order Confirmation',
        description: 'Sent to the customer when a sale/order is created for them.',
        recipient: 'Customer',
        defaultEnabled: true,
        subject: 'Your {{storeName}} order {{transactionId}} is confirmed',
        html: wrap({
            heading: 'Thank you, {{userName}}!',
            intro: 'Your order with <strong>{{storeName}}</strong> has been confirmed. Here are the details:',
            detailRows: row('Order', 'transactionId') + row('Total', 'total', '{{currency}}'),
            ctaLabel: 'View your orders',
            ctaVar: 'ordersUrl',
            footnote: 'Questions about your order? Just reply to this email.',
        }),
        variables: [
            { name: 'userName', description: 'Customer name' },
            { name: 'storeName', description: 'Store name' },
            { name: 'transactionId', description: 'Order / transaction ID' },
            { name: 'total', description: 'Order total (money)' },
            { name: 'currency', description: 'Store currency symbol' },
            { name: 'ordersUrl', description: 'Link to the customer’s orders' },
        ],
        sample: { userName: 'Jane Banda', storeName: 'Downtown Minimart', transactionId: 'SALE-1042', total: 1250, currency: 'K' },
    },
    {
        key: 'LOW_STOCK_ALERT',
        name: 'Low Stock Alert',
        description: 'Sent to the store owner when a product drops to or below its reorder point.',
        recipient: 'Store owner',
        defaultEnabled: true,
        subject: '⚠️ Low stock: {{productName}} at {{storeName}}',
        html: wrap({
            heading: 'Low stock warning',
            intro: '<strong>{{productName}}</strong> is running low and may need reordering.',
            detailRows: row('Product', 'productName') + row('Current stock', 'currentStock') + row('Reorder point', 'reorderPoint'),
            ctaLabel: 'Manage inventory',
            ctaVar: 'inventoryUrl',
        }),
        variables: [
            { name: 'productName', description: 'Product name' },
            { name: 'currentStock', description: 'Units left' },
            { name: 'reorderPoint', description: 'Reorder threshold' },
            { name: 'storeName', description: 'Store name' },
            { name: 'inventoryUrl', description: 'Link to inventory' },
        ],
        sample: { productName: 'Coca-Cola 500ml', currentStock: 4, reorderPoint: 10, storeName: 'Downtown Minimart' },
    },
    {
        key: 'SALES_RETURN_PROCESSED',
        name: 'Sales Return Processed',
        description: 'Sent to the store owner when a refund/return is recorded (refund ≥ 100).',
        recipient: 'Store owner',
        defaultEnabled: true,
        subject: 'Return processed for order {{transactionId}}',
        html: wrap({
            heading: 'A return was processed',
            intro: 'A refund has been recorded against order <strong>{{transactionId}}</strong>.',
            detailRows: row('Original order', 'transactionId') + row('Refund amount', 'refundAmount', '{{currency}}'),
            ctaLabel: 'View sales history',
            ctaVar: 'ordersUrl',
        }),
        variables: [
            { name: 'transactionId', description: 'Original order ID' },
            { name: 'refundAmount', description: 'Refunded amount (money)' },
            { name: 'currency', description: 'Store currency symbol' },
            { name: 'storeName', description: 'Store name' },
            { name: 'ordersUrl', description: 'Link to sales history' },
        ],
        sample: { transactionId: 'SALE-1042', refundAmount: 300, currency: 'K', storeName: 'Downtown Minimart' },
    },
    {
        key: 'PO_RECEPTION_RECEIVED',
        name: 'Purchase Order Received',
        description: 'Sent to the store owner when stock is received against a purchase order.',
        recipient: 'Store owner',
        defaultEnabled: true,
        subject: 'Stock received for PO {{poNumber}}',
        html: wrap({
            heading: 'Purchase order received',
            intro: 'Stock has been received into your inventory for purchase order <strong>{{poNumber}}</strong>.',
            detailRows: row('PO number', 'poNumber') + row('Items received', 'itemCount') + row('Total cost', 'totalCost', '{{currency}}'),
            ctaLabel: 'View inventory',
            ctaVar: 'inventoryUrl',
        }),
        variables: [
            { name: 'poNumber', description: 'Purchase order number' },
            { name: 'itemCount', description: 'Number of line items received' },
            { name: 'totalCost', description: 'Total cost received (money)' },
            { name: 'currency', description: 'Store currency symbol' },
            { name: 'storeName', description: 'Store name' },
            { name: 'inventoryUrl', description: 'Link to inventory' },
        ],
        sample: { poNumber: 'PO-2025-014', itemCount: 12, totalCost: 8400, currency: 'K', storeName: 'Downtown Minimart' },
    },
    {
        key: 'SUPPLIER_PAYMENT_MADE',
        name: 'Supplier Payment Made',
        description: 'Sent to the store owner when a payment to a supplier is recorded.',
        recipient: 'Store owner',
        defaultEnabled: true,
        subject: 'Payment recorded for {{supplierName}}',
        html: wrap({
            heading: 'Supplier payment recorded',
            intro: 'A payment to <strong>{{supplierName}}</strong> has been recorded in your books.',
            detailRows: row('Supplier', 'supplierName') + row('Invoice', 'invoiceNumber') + row('Amount', 'amount', '{{currency}}'),
            ctaLabel: 'Open accounting',
            ctaVar: 'booksUrl',
        }),
        variables: [
            { name: 'supplierName', description: 'Supplier name' },
            { name: 'invoiceNumber', description: 'Supplier invoice number' },
            { name: 'amount', description: 'Amount paid (money)' },
            { name: 'currency', description: 'Store currency symbol' },
            { name: 'storeName', description: 'Store name' },
            { name: 'booksUrl', description: 'Link to accounting' },
        ],
        sample: { supplierName: 'Zambeef Ltd', invoiceNumber: 'INV-0098', amount: 5400, currency: 'K', storeName: 'Downtown Minimart' },
    },
    {
        key: 'LARGE_EXPENSE_RECORDED',
        name: 'Large Expense Recorded',
        description: 'Sent to the store owner when a sizeable expense is recorded.',
        recipient: 'Store owner',
        defaultEnabled: true,
        subject: 'Large expense recorded at {{storeName}}',
        html: wrap({
            heading: 'A large expense was recorded',
            intro: 'An expense above your alert threshold has been recorded in your books.',
            detailRows: row('Description', 'description') + row('Amount', 'amount', '{{currency}}'),
            ctaLabel: 'Review in accounting',
            ctaVar: 'booksUrl',
        }),
        variables: [
            { name: 'description', description: 'Expense description' },
            { name: 'amount', description: 'Expense amount (money)' },
            { name: 'currency', description: 'Store currency symbol' },
            { name: 'storeName', description: 'Store name' },
            { name: 'booksUrl', description: 'Link to accounting' },
        ],
        sample: { description: 'Monthly rent', amount: 6000, currency: 'K', storeName: 'Downtown Minimart' },
        condition: { field: 'minAmount', label: 'Only send when the expense is at least', default: 500 },
    },
    {
        key: 'SUBSCRIPTION_ACTIVE',
        name: 'Subscription Activated',
        description: 'Sent to the store owner when a paid subscription becomes active.',
        recipient: 'Store owner',
        defaultEnabled: true,
        subject: 'Your {{storeName}} subscription is active 🎉',
        html: wrap({
            heading: 'Your subscription is active!',
            intro: 'Thank you, {{userName}} — your <strong>{{planId}}</strong> plan for {{storeName}} is now active. Enjoy your premium features.',
            detailRows: row('Plan', 'planId'),
            ctaLabel: 'Manage subscription',
            ctaVar: 'subscriptionUrl',
        }),
        variables: [
            { name: 'userName', description: 'Owner name' },
            { name: 'planId', description: 'Subscription plan' },
            { name: 'storeName', description: 'Store name' },
            { name: 'subscriptionUrl', description: 'Link to subscription settings' },
        ],
        sample: { userName: 'Jane Banda', planId: 'Pro', storeName: 'Downtown Minimart' },
    },
    {
        key: 'SUBSCRIPTION_CANCELLED',
        name: 'Subscription Cancelled',
        description: 'Sent to the store owner when a subscription is cancelled.',
        recipient: 'Store owner',
        defaultEnabled: true,
        subject: 'Your {{storeName}} subscription was cancelled',
        html: wrap({
            heading: 'Subscription cancelled',
            intro: 'Hi {{userName}}, your <strong>{{planId}}</strong> plan for {{storeName}} has been cancelled. You can resubscribe any time.',
            detailRows: row('Plan', 'planId'),
            ctaLabel: 'Resubscribe',
            ctaVar: 'subscriptionUrl',
        }),
        variables: [
            { name: 'userName', description: 'Owner name' },
            { name: 'planId', description: 'Subscription plan' },
            { name: 'storeName', description: 'Store name' },
            { name: 'subscriptionUrl', description: 'Link to subscription settings' },
        ],
        sample: { userName: 'Jane Banda', planId: 'Pro', storeName: 'Downtown Minimart' },
    },

    // ── Onboarding tips — sent by the periodic scheduler N days after signup ──
    {
        key: 'TIP_LOGO',
        name: 'Tip: Add your logo',
        description: 'Onboarding tip nudging new users to upload their logo. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 1 },
        subject: 'Tip: Make your receipts look professional 🖼️',
        html: wrap({
            heading: 'Add your logo, {{userName}}',
            intro: 'You can upload your business logo in Settings — it appears on every digital and printed receipt, giving your store a polished, professional look.',
            ctaLabel: 'Upload your logo',
            ctaVar: 'settingsUrl',
            footnote: 'A small touch that makes a big impression on your customers.',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'settingsUrl', description: 'Link to settings' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_REPORTS',
        name: 'Tip: Track your numbers',
        description: 'Onboarding tip pointing new users to Reports. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 3 },
        subject: 'Tip: See your profit at a glance 📊',
        html: wrap({
            heading: 'Know your business health',
            intro: 'Hi {{userName}}, the Reports section shows your daily profit &amp; loss, sales trends and inventory value in real time. Staying on top of your numbers is the key to growth.',
            ctaLabel: 'Open Reports',
            ctaVar: 'reportsUrl',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'reportsUrl', description: 'Link to Reports' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_REFERRAL',
        name: 'Tip: Refer & earn',
        description: 'Onboarding tip promoting the referral program. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 7 },
        subject: 'Tip: Earn discounts by referring friends 💸',
        html: wrap({
            heading: 'Share SalePilot, get rewarded',
            intro: 'Enjoying SalePilot, {{userName}}? Share your referral code and earn a discount on your next subscription for every business that signs up.',
            detailRows: row('Your referral code', 'referralCode'),
            ctaLabel: 'View your rewards',
            ctaVar: 'subscriptionUrl',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'referralCode', description: 'The user’s referral code' },
            { name: 'subscriptionUrl', description: 'Link to subscription / rewards' },
        ],
        sample: { userName: 'Jane Banda', referralCode: 'JANE-4X2K' },
    },
    {
        key: 'TIP_PRODUCTS',
        name: 'Tip: Stock your catalog',
        description: 'Onboarding tip nudging new users to add their first products. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 2 },
        subject: 'Tip: Add your products and start selling 📦',
        html: wrap({
            heading: 'Build your catalog, {{userName}}',
            intro: 'Add your products with prices, cost and stock levels — then they’re ready to ring up on the register and SalePilot tracks your inventory and profit automatically.',
            ctaLabel: 'Add products',
            ctaVar: 'inventoryUrl',
            footnote: 'Tip: you can bulk-import from a purchase order checklist too.',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'inventoryUrl', description: 'Link to inventory' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_FIRST_SALE',
        name: 'Tip: Make your first sale',
        description: 'Onboarding tip encouraging the user to ring up their first sale in the POS. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 5 },
        subject: 'Tip: Ring up a sale in seconds 🧾',
        html: wrap({
            heading: 'Ready to sell, {{userName}}?',
            intro: 'The register is built for speed — scan or tap products, take any payment method, and print or send a receipt. Cash, mobile money and card are all supported.',
            ctaLabel: 'Open the register',
            ctaVar: 'posUrl',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'posUrl', description: 'Link to the POS register' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_CUSTOMERS',
        name: 'Tip: Build your customer list',
        description: 'Onboarding tip pointing new users to the CRM to add customers. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 10 },
        subject: 'Tip: Turn buyers into regulars 🤝',
        html: wrap({
            heading: 'Know your customers',
            intro: 'Hi {{userName}}, add customers to track their purchases, offer store credit, and reach out with WhatsApp campaigns. Loyal customers are your most profitable ones.',
            ctaLabel: 'Add customers',
            ctaVar: 'customersUrl',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'customersUrl', description: 'Link to customers (CRM)' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_SUPPLIERS',
        name: 'Tip: Restock smarter',
        description: 'Onboarding tip about suppliers and purchase orders. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 14 },
        subject: 'Tip: Never run out of stock again 🚚',
        html: wrap({
            heading: 'Restock without the guesswork',
            intro: 'Add your suppliers and raise purchase orders, {{userName}}. SalePilot flags low stock and updates your inventory and costs the moment goods are received.',
            ctaLabel: 'Set up purchasing',
            ctaVar: 'purchaseOrdersUrl',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'purchaseOrdersUrl', description: 'Link to purchase orders' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_TEAM',
        name: 'Tip: Add your team',
        description: 'Onboarding tip encouraging the owner to invite staff with roles. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 21 },
        subject: 'Tip: Bring your team on board 👥',
        html: wrap({
            heading: 'Add your staff, {{userName}}',
            intro: 'Invite team members and give each the right role — cashiers, inventory managers or admins — so everyone can help run the shop while you stay in control of what they can access.',
            ctaLabel: 'Invite your team',
            ctaVar: 'teamUrl',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'teamUrl', description: 'Link to team management' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_BOOKS',
        name: 'Tip: Keep your books in order',
        description: 'Onboarding tip pointing new users to the Accounting hub. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 17 },
        subject: 'Tip: Your books, done automatically 📒',
        html: wrap({
            heading: 'Stay on top of the money, {{userName}}',
            intro: 'Every sale, return and expense is posted to your books automatically. Open Accounting to record expenses, track what customers owe you and what you owe suppliers, and see your profit &amp; loss and balance sheet — no bookkeeper required.',
            ctaLabel: 'Open Accounting',
            ctaVar: 'booksUrl',
            footnote: 'Tip: record your rent and bills as expenses so your profit figures stay accurate.',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'booksUrl', description: 'Link to the Accounting hub' },
        ],
        sample: { userName: 'Jane Banda' },
    },
    {
        key: 'TIP_STOCK_TAKE',
        name: 'Tip: Run a stock take',
        description: 'Onboarding tip encouraging the user to reconcile inventory with a stock take. Sent by the scheduler a set number of days after signup.',
        recipient: 'New user',
        category: 'tip',
        defaultEnabled: true,
        schedule: { field: 'sendDay', label: 'Send this many days after signup', default: 25 },
        subject: 'Tip: Keep your stock counts accurate 🔢',
        html: wrap({
            heading: 'Count your stock the easy way',
            intro: 'Hi {{userName}}, a stock take reconciles what’s actually on your shelves with what SalePilot expects — catching shrinkage, damage and miscounts. Any differences are valued and posted to your books automatically, so your inventory and profit stay trustworthy.',
            ctaLabel: 'Start a stock take',
            ctaVar: 'stockTakesUrl',
        }),
        variables: [
            { name: 'userName', description: 'User name' },
            { name: 'stockTakesUrl', description: 'Link to stock takes' },
        ],
        sample: { userName: 'Jane Banda' },
    },
];

const DEF_BY_KEY = new Map(EMAIL_TEMPLATES.map(t => [t.key, t]));

/** Insert any missing default templates. Idempotent; never overwrites edits. */
const defaultConfig = (t: EmailTemplateDef): Record<string, any> => {
    const config: Record<string, any> = {};
    if (t.condition) config[t.condition.field] = t.condition.default;
    if (t.schedule) config[t.schedule.field] = t.schedule.default;
    return config;
};

export const ensureEmailTemplatesSeeded = async (dbClient: { query: (t: string, p?: any[]) => Promise<any> } = db) => {
    for (const t of EMAIL_TEMPLATES) {
        await dbClient.query(
            `INSERT INTO email_templates (key, name, subject, html, enabled, config, category)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (key) DO NOTHING`,
            [t.key, t.name, t.subject, t.html, t.defaultEnabled, JSON.stringify(defaultConfig(t)), t.category ?? 'event'],
        );
    }
};

// ── Custom tips (superadmin-built, DB-only) ─────────────────────────────────
// They have no code definition, so they share one variable set + sample, and
// the standard "N days after signup" schedule. The scheduler passes userName +
// referralCode; the engine injects every link below automatically.
export const TIP_VARIABLES: EmailTemplateVar[] = [
    { name: 'userName', description: 'The user’s name' },
    { name: 'referralCode', description: 'The user’s referral code' },
    { name: 'appUrl', description: 'App home' },
    { name: 'dashboardUrl', description: 'Dashboard' },
    { name: 'posUrl', description: 'POS register' },
    { name: 'inventoryUrl', description: 'Inventory' },
    { name: 'stockTakesUrl', description: 'Stock takes' },
    { name: 'ordersUrl', description: 'Sales history' },
    { name: 'customersUrl', description: 'Customers (CRM)' },
    { name: 'suppliersUrl', description: 'Suppliers' },
    { name: 'purchaseOrdersUrl', description: 'Purchase orders' },
    { name: 'teamUrl', description: 'Team management' },
    { name: 'booksUrl', description: 'Accounting' },
    { name: 'reportsUrl', description: 'Reports' },
    { name: 'settingsUrl', description: 'Settings' },
    { name: 'subscriptionUrl', description: 'Subscription' },
];
const TIP_SAMPLE = { userName: 'Jane Banda', referralCode: 'JANE-4X2K' };
const TIP_SCHEDULE: EmailTemplateCondition = { field: 'sendDay', label: 'Send this many days after signup', default: 3 };

/** On-brand starter HTML for a brand-new custom tip. */
const blankTipHtml = () => wrap({
    heading: 'Hi {{userName}},',
    intro: 'Write your tip here. Use the variable chips to insert things like the user’s name or a link into your app.',
    ctaLabel: 'Open SalePilot',
    ctaVar: 'dashboardUrl',
});

interface EmailTemplateRow {
    key: string; name: string; subject: string; html: string;
    enabled: boolean; config: Record<string, any>; category: string;
    updated_at: string; updated_by: string | null;
}

export const isBuiltIn = (key: string) => DEF_BY_KEY.has(key);

const getRow = async (key: string): Promise<EmailTemplateRow | null> => {
    const r = await db.query('SELECT * FROM email_templates WHERE key = $1', [key]);
    return r.rowCount ? r.rows[0] : null;
};

/**
 * Templates for the admin UI: the built-in definitions (merged with their stored
 * edits) followed by any superadmin-built custom tips (DB-only rows). `builtIn`
 * tells the UI which can be renamed / deleted (custom only) and reset (built-in).
 */
export const listEmailTemplates = async () => {
    await ensureEmailTemplatesSeeded();
    const r = await db.query('SELECT * FROM email_templates ORDER BY key');
    const rows: EmailTemplateRow[] = r.rows;

    const builtIns = EMAIL_TEMPLATES.map(def => {
        const row = rows.find(x => x.key === def.key);
        return {
            key: def.key,
            name: row?.name ?? def.name,
            description: def.description,
            recipient: def.recipient,
            category: def.category ?? 'event',
            builtIn: true,
            variables: def.variables,
            sample: def.sample,
            condition: def.condition || null,
            schedule: def.schedule || null,
            subject: row?.subject ?? def.subject,
            html: row?.html ?? def.html,
            enabled: row?.enabled ?? def.defaultEnabled,
            config: row?.config ?? defaultConfig(def),
            updatedAt: row?.updated_at ?? null,
            updatedBy: row?.updated_by ?? null,
        };
    });

    // Rows with no code definition are custom (superadmin-built) tips.
    const custom = rows
        .filter(row => !DEF_BY_KEY.has(row.key))
        .sort((a, b) => Number(a.config?.sendDay ?? 0) - Number(b.config?.sendDay ?? 0))
        .map(row => ({
            key: row.key,
            name: row.name,
            description: 'Custom tip created by you.',
            recipient: 'New user',
            category: row.category || 'tip',
            builtIn: false,
            variables: TIP_VARIABLES,
            sample: TIP_SAMPLE,
            condition: null,
            schedule: TIP_SCHEDULE,
            subject: row.subject,
            html: row.html,
            enabled: row.enabled,
            config: row.config ?? { sendDay: TIP_SCHEDULE.default },
            updatedAt: row.updated_at,
            updatedBy: row.updated_by,
        }));

    return [...builtIns, ...custom];
};

/** Create a new custom onboarding tip (DB-only, superadmin-built). */
export const createCustomTip = async (
    input: { name?: string; subject?: string; html?: string; sendDay?: number; enabled?: boolean },
    updatedBy?: string,
) => {
    const key = generateId('tip');
    const name = (input.name && input.name.trim()) || 'New tip';
    const subject = (input.subject && input.subject.trim()) || 'Tip: ...';
    const html = (input.html && input.html.trim()) || blankTipHtml();
    const sendDay = Number.isFinite(Number(input.sendDay)) && Number(input.sendDay) > 0 ? Math.floor(Number(input.sendDay)) : TIP_SCHEDULE.default;
    const enabled = input.enabled ?? false; // start disabled so drafts don't send
    await db.query(
        `INSERT INTO email_templates (key, name, subject, html, enabled, config, category, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, 'tip', $7)`,
        [key, name, subject, html, enabled, JSON.stringify({ sendDay }), updatedBy ?? null],
    );
    return getRow(key);
};

/** Delete a custom tip. Built-in templates cannot be deleted. */
export const deleteEmailTemplate = async (key: string) => {
    if (DEF_BY_KEY.has(key)) throw new Error('Built-in templates cannot be deleted.');
    const res = await db.query('DELETE FROM email_templates WHERE key = $1 RETURNING key', [key]);
    if (res.rowCount === 0) throw new Error(`Unknown email template: ${key}`);
    return true;
};

/** Sample data for previewing/testing a template (built-in def sample or the tip sample). */
export const getTemplateSample = (key: string): Record<string, any> | null => {
    const def = DEF_BY_KEY.get(key);
    if (def) return def.sample;
    return TIP_SAMPLE; // custom tip
};

/** Restore a template's subject + HTML to the on-brand default (keeps enabled/config). */
export const resetEmailTemplate = async (key: string, updatedBy?: string) => {
    const def = DEF_BY_KEY.get(key);
    if (!def) throw new Error(`Unknown email template: ${key}`);
    await ensureEmailTemplatesSeeded();
    await db.query(
        `UPDATE email_templates SET subject=$1, html=$2, updated_at=NOW(), updated_by=$3 WHERE key=$4`,
        [def.subject, def.html, updatedBy ?? null, key],
    );
    return getRow(key);
};

/** Enabled onboarding-tip templates merged with their stored config (for the scheduler). */
export const getScheduledTipTemplates = async () => {
    const all = await listEmailTemplates();
    return all
        .filter(t => t.category === 'tip' && t.enabled)
        .map(t => ({
            key: t.key,
            sendDay: Number(t.config?.sendDay ?? t.schedule?.default ?? 0),
        }))
        .filter(t => Number.isFinite(t.sendDay) && t.sendDay > 0);
};

export const updateEmailTemplate = async (
    key: string,
    patch: { name?: string; subject?: string; html?: string; enabled?: boolean; config?: Record<string, any> },
    updatedBy?: string,
) => {
    await ensureEmailTemplatesSeeded();
    const current = await getRow(key);
    // Must exist as a built-in def or a custom row.
    if (!current && !DEF_BY_KEY.has(key)) throw new Error(`Unknown email template: ${key}`);
    // Only custom tips can be renamed (built-in names come from code).
    const name = (!DEF_BY_KEY.has(key) && patch.name?.trim()) ? patch.name.trim() : (current?.name ?? DEF_BY_KEY.get(key)?.name ?? key);
    const subject = patch.subject ?? current?.subject ?? '';
    const html = patch.html ?? current?.html ?? '';
    const enabled = patch.enabled ?? current?.enabled ?? true;
    const config = patch.config ?? current?.config ?? {};
    await db.query(
        `UPDATE email_templates SET name=$1, subject=$2, html=$3, enabled=$4, config=$5, updated_at=NOW(), updated_by=$6 WHERE key=$7`,
        [name, subject, html, enabled, JSON.stringify(config), updatedBy ?? null, key],
    );
    return getRow(key);
};

/** Build the full substitution context (data + money formatting + links). */
const buildContext = (data: Record<string, any>): Record<string, any> => {
    const ctx: Record<string, any> = { currency: 'K', ...globalContext(), ...data };
    for (const f of MONEY_FIELDS) {
        if (ctx[f] != null && ctx[f] !== '') ctx[f] = formatMoney(ctx[f]);
    }
    return ctx;
};

/**
 * Row-aware preview/test render. Resolves the effective subject/HTML from
 * (client override → stored row → built-in default) so it works for custom tips
 * that have no code definition. Returns null if the key is unknown.
 */
export const previewTemplate = async (
    key: string,
    override?: { subject?: string; html?: string },
): Promise<{ subject: string; html: string } | null> => {
    const def = DEF_BY_KEY.get(key);
    const row = await getRow(key);
    if (!def && !row) return null;
    const sample = def ? def.sample : TIP_SAMPLE;
    const ctx = buildContext(sample);
    const subject = renderString(override?.subject ?? row?.subject ?? def?.subject ?? '', ctx);
    const html = renderString(override?.html ?? row?.html ?? def?.html ?? '', ctx);
    return { subject, html };
};

/** Render a template's subject + HTML for arbitrary data (used by the send path). */
export const renderEmailTemplate = (
    key: string,
    data: Record<string, any>,
    override?: { subject?: string; html?: string },
): { subject: string; html: string } => {
    const def = DEF_BY_KEY.get(key);
    const ctx = buildContext(data);
    const subject = renderString(override?.subject ?? def?.subject ?? '', ctx);
    const html = renderString(override?.html ?? def?.html ?? '', ctx);
    return { subject, html };
};

/**
 * Core send entry point. Honours enabled + numeric conditions, renders from the
 * stored (superadmin-editable) template, and sends via nodemailer. Failures are
 * swallowed (email is best-effort and must never break the triggering action).
 */
export const sendTemplatedEmail = async (key: string, to: string, data: Record<string, any>): Promise<boolean> => {
    try {
        if (!to) return false;
        const def = DEF_BY_KEY.get(key);
        const row = await getRow(key);
        // Must be a known built-in or an existing custom row.
        if (!def && !row) { console.warn(`[email-engine] Unknown template key: ${key}`); return false; }

        const enabled = row?.enabled ?? def?.defaultEnabled ?? false;
        if (!enabled) return false;

        // Numeric condition gate (e.g. LARGE_EXPENSE_RECORDED minAmount). Tips have none.
        if (def?.condition) {
            const threshold = Number(row?.config?.[def.condition.field] ?? def.condition.default);
            const value = Number(data[def.condition.field] ?? data.amount ?? 0);
            if (Number.isFinite(threshold) && value < threshold) return false;
        }

        const { subject, html } = renderEmailTemplate(key, data, { subject: row?.subject, html: row?.html });
        await sendEmail(to, subject, html);
        return true;
    } catch (err) {
        console.error(`[email-engine] Failed to send "${key}":`, err);
        return false;
    }
};

/**
 * Resolve a store's owner email + store name + currency, then send. Replaces the
 * repeated owner-lookup boilerplate at the old mail_events call sites. `amount`
 * fields for the condition gate are passed through in `data`.
 */
export const notifyStoreOwner = async (key: string, storeId: string, data: Record<string, any>): Promise<boolean> => {
    try {
        if (!storeId) return false;
        const storeRes = await db.query('SELECT owner_id, name FROM stores WHERE id = $1', [storeId]);
        if (!storeRes.rowCount || !storeRes.rows[0].owner_id) return false;
        const ownerId = storeRes.rows[0].owner_id;

        const ownerRes = await db.query('SELECT email, name FROM users WHERE id = $1', [ownerId]);
        if (!ownerRes.rowCount || !ownerRes.rows[0].email) return false;

        // Prefer the store-settings display name + currency symbol when present.
        const settingsRes = await db.query('SELECT name, currency FROM store_settings WHERE store_id = $1', [storeId]);
        const storeName = settingsRes.rows[0]?.name || storeRes.rows[0].name || 'your store';
        const currency = settingsRes.rows[0]?.currency?.symbol || 'K';

        return await sendTemplatedEmail(key, ownerRes.rows[0].email, {
            storeName,
            currency,
            userName: ownerRes.rows[0].name || 'there',
            ...data,
        });
    } catch (err) {
        console.error(`[email-engine] notifyStoreOwner "${key}" failed:`, err);
        return false;
    }
};

export const emailTemplateService = {
    ensureEmailTemplatesSeeded,
    listEmailTemplates,
    createCustomTip,
    updateEmailTemplate,
    deleteEmailTemplate,
    resetEmailTemplate,
    renderEmailTemplate,
    previewTemplate,
    sendTemplatedEmail,
    notifyStoreOwner,
    getScheduledTipTemplates,
    getTemplateSample,
    isBuiltIn,
    EMAIL_TEMPLATES,
};
