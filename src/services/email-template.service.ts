import db from '../db_client';
import { sendEmail } from './email.service';

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
        inventoryUrl: `${base}/inv/items`,
        ordersUrl: `${base}/pos/history`,
        booksUrl: `${base}/books`,
        subscriptionUrl: `${base}/subscription`,
        year: new Date().getFullYear(),
    };
};

/** Replace {{ var }} tokens; unknown tokens render empty (never leak "{{x}}"). */
export const renderString = (template: string, ctx: Record<string, any>): string =>
    template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key) => (ctx[key] != null ? String(ctx[key]) : ''));

// ── Shared on-brand wrapper used to GENERATE the default HTML. The stored value
// is the full document, so a superadmin can edit any part of it. ──────────────
const NAVY = '#002B6B';
const ORANGE = '#FF7F27';

const wrap = (opts: { heading: string; intro: string; detailRows?: string; ctaLabel?: string; ctaVar?: string; footnote?: string }) => `
<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;background:#f4f6fb;padding:24px;">
  <div style="background:${NAVY};border-radius:16px 16px 0 0;padding:24px 28px;text-align:center;">
    <span style="color:#fff;font-size:20px;font-weight:800;letter-spacing:-0.02em;">Sale<span style="color:${ORANGE};">Pilot</span></span>
  </div>
  <div style="background:#fff;padding:32px 28px;border:1px solid #e6eaf2;border-top:0;">
    <h1 style="margin:0 0 12px;color:#0f172a;font-size:21px;font-weight:800;">${opts.heading}</h1>
    <p style="margin:0 0 20px;color:#475569;font-size:15px;line-height:1.6;">${opts.intro}</p>
    ${opts.detailRows ? `<table style="width:100%;border-collapse:collapse;margin:0 0 24px;background:#f8fafc;border:1px solid #e6eaf2;border-radius:12px;overflow:hidden;">${opts.detailRows}</table>` : ''}
    ${opts.ctaLabel && opts.ctaVar ? `<div style="text-align:center;margin:8px 0 4px;"><a href="{{${opts.ctaVar}}}" style="display:inline-block;background:${ORANGE};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:13px 30px;border-radius:10px;">${opts.ctaLabel}</a></div>` : ''}
    ${opts.footnote ? `<p style="margin:20px 0 0;color:#94a3b8;font-size:13px;line-height:1.5;">${opts.footnote}</p>` : ''}
  </div>
  <div style="text-align:center;padding:18px;color:#94a3b8;font-size:12px;">
    © {{year}} SalePilot · <a href="{{appUrl}}" style="color:${NAVY};text-decoration:none;">salepilot.space</a>
  </div>
</div>`.trim();

const row = (label: string, valueVar: string, prefix = '') =>
    `<tr><td style="padding:12px 16px;color:#64748b;font-size:13px;font-weight:600;border-bottom:1px solid #eef1f6;">${label}</td><td style="padding:12px 16px;color:#0f172a;font-size:14px;font-weight:700;text-align:right;border-bottom:1px solid #eef1f6;">${prefix}{{${valueVar}}}</td></tr>`;

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
];

const DEF_BY_KEY = new Map(EMAIL_TEMPLATES.map(t => [t.key, t]));

/** Insert any missing default templates. Idempotent; never overwrites edits. */
export const ensureEmailTemplatesSeeded = async (dbClient: { query: (t: string, p?: any[]) => Promise<any> } = db) => {
    for (const t of EMAIL_TEMPLATES) {
        const config = t.condition ? { [t.condition.field]: t.condition.default } : {};
        await dbClient.query(
            `INSERT INTO email_templates (key, name, subject, html, enabled, config)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (key) DO NOTHING`,
            [t.key, t.name, t.subject, t.html, t.defaultEnabled, JSON.stringify(config)],
        );
    }
};

interface EmailTemplateRow {
    key: string; name: string; subject: string; html: string;
    enabled: boolean; config: Record<string, any>; updated_at: string; updated_by: string | null;
}

const getRow = async (key: string): Promise<EmailTemplateRow | null> => {
    const r = await db.query('SELECT * FROM email_templates WHERE key = $1', [key]);
    return r.rowCount ? r.rows[0] : null;
};

/** Merge the stored rows with their static definitions for the admin UI. */
export const listEmailTemplates = async () => {
    await ensureEmailTemplatesSeeded();
    const r = await db.query('SELECT * FROM email_templates ORDER BY key');
    const rows: EmailTemplateRow[] = r.rows;
    // Preserve the definition order; only surface keys we still define.
    return EMAIL_TEMPLATES.map(def => {
        const row = rows.find(x => x.key === def.key);
        return {
            key: def.key,
            name: def.name,
            description: def.description,
            recipient: def.recipient,
            variables: def.variables,
            sample: def.sample,
            condition: def.condition || null,
            subject: row?.subject ?? def.subject,
            html: row?.html ?? def.html,
            enabled: row?.enabled ?? def.defaultEnabled,
            config: row?.config ?? (def.condition ? { [def.condition.field]: def.condition.default } : {}),
            updatedAt: row?.updated_at ?? null,
            updatedBy: row?.updated_by ?? null,
        };
    });
};

export const updateEmailTemplate = async (
    key: string,
    patch: { subject?: string; html?: string; enabled?: boolean; config?: Record<string, any> },
    updatedBy?: string,
) => {
    if (!DEF_BY_KEY.has(key)) throw new Error(`Unknown email template: ${key}`);
    await ensureEmailTemplatesSeeded();
    const current = await getRow(key);
    const subject = patch.subject ?? current?.subject ?? '';
    const html = patch.html ?? current?.html ?? '';
    const enabled = patch.enabled ?? current?.enabled ?? true;
    const config = patch.config ?? current?.config ?? {};
    await db.query(
        `UPDATE email_templates SET subject=$1, html=$2, enabled=$3, config=$4, updated_at=NOW(), updated_by=$5 WHERE key=$6`,
        [subject, html, enabled, JSON.stringify(config), updatedBy ?? null, key],
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

/** Render a template's subject + HTML for arbitrary data (used by preview/test). */
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
        if (!def) { console.warn(`[email-engine] Unknown template key: ${key}`); return false; }

        const row = await getRow(key);
        const enabled = row?.enabled ?? def.defaultEnabled;
        if (!enabled) return false;

        // Numeric condition gate (e.g. LARGE_EXPENSE_RECORDED minAmount).
        if (def.condition) {
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
    updateEmailTemplate,
    renderEmailTemplate,
    sendTemplatedEmail,
    notifyStoreOwner,
    EMAIL_TEMPLATES,
};
