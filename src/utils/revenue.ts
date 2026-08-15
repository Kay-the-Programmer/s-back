/**
 * The platform's ONE definition of revenue, as SQL fragments.
 *
 * Every figure the app shows for "sales" or "revenue" means the same thing:
 *
 *   accrual · ex-tax · net of discount · net of returns · excludes cancelled
 *
 * Tax is money held for the revenue authority, not income, so it never counts.
 * The order-level discount lives on the sale, not the line, so any per-product
 * or per-category figure has to apportion it — otherwise a K400 basket sold for
 * K360 reports as K400 and the same day reads differently on two screens.
 *
 * These fragments assume the query aliases `sales` as `s` and, for the line
 * variants, `sale_items` as `si`. Import them instead of hand-writing the
 * arithmetic: this file existing is what stops the definitions drifting apart
 * again.
 */

/** Cancelled sales never happened, financially. */
export const NOT_CANCELLED = `s.fulfillment_status IS DISTINCT FROM 'cancelled'`;

/**
 * The same two fragments for queries that select `FROM sales` without an alias
 * (several AI-context queries do). Pass '' for no prefix.
 */
export const saleRevenueFor = (alias = 's') => {
    const p = alias ? `${alias}.` : '';
    return `(${p}subtotal - COALESCE(${p}discount, 0))`;
};

export const notCancelledFor = (alias = 's') => {
    const p = alias ? `${alias}.` : '';
    return `${p}fulfillment_status IS DISTINCT FROM 'cancelled'`;
};

/**
 * Sale-level revenue: what the customer agreed to pay, before tax and after the
 * discount. Refunds are NOT deducted here — callers that need net-of-returns
 * either subtract the refunds total separately (the dashboard does, so it can
 * show both) or use {@link SALE_NET_OF_REFUNDS}.
 */
export const SALE_REVENUE = `(s.subtotal - COALESCE(s.discount, 0))`;

/**
 * The share of a sale that survived refunds, as a 0–1 factor. Measured against
 * the ORIGINAL total: `sales.total` is the pre-refund figure in the database
 * (the refund-netted one is computed in the read path), so this stays correct
 * as long as it is applied to the raw column.
 */
export const SURVIVING_FRACTION = (refundedExpr: string) =>
    `COALESCE(1 - LEAST(1, ${refundedExpr} / NULLIF(s.total, 0)), 1)`;

/** Sale-level revenue with refunds taken off, given a refunds sub-select alias. */
export const SALE_NET_OF_REFUNDS = (refundedExpr: string) =>
    `${SALE_REVENUE} * ${SURVIVING_FRACTION(refundedExpr)}`;

/**
 * The sale's discount as a factor to apply to its lines: 1 when undiscounted,
 * 0.9 for a 10%-off basket. NULLIF guards a zero subtotal; COALESCE keeps a
 * malformed row contributing its face value rather than NULL (which would
 * silently drop it from a SUM).
 */
export const DISCOUNT_FACTOR = `COALESCE(1 - COALESCE(s.discount, 0) / NULLIF(s.subtotal, 0), 1)`;

/**
 * Line-level revenue — the per-product and per-category figure. Carries the
 * sale's share of the order discount, so the lines of one sale add back up to
 * {@link SALE_REVENUE}.
 *
 * GROSS OF RETURNS, on purpose. A refund belongs to the period it happens in,
 * not the one the sale was rung in — the same rule the dashboard, the
 * accounting summary and the COGS calculation already follow. Netting
 * `returned_quantity` here dated the refund by the SALE instead, so an August
 * return silently reduced April's figures and a closed month could never be
 * relied on. Returns are reported separately, dated by the return.
 */
export const LINE_REVENUE = `si.price_at_sale * si.quantity * ${DISCOUNT_FACTOR}`;

/** Line-level cost of what was sold — matches the COGS convention above. */
export const LINE_COST = `si.cost_at_sale * si.quantity`;

/** Units sold in the period (returns are counted in their own period). */
export const LINE_QUANTITY = `si.quantity`;

/**
 * Units returned IN a period, dated by the return. Pairs with the sold figures
 * above so a report can show both without either rewriting the other's history.
 * Expects `return_items ri` joined to `returns r`.
 */
export const RETURNED_QUANTITY = `ri.quantity`;

/**
 * ONE conversion from a requested reporting period to the SQL bounds used with
 * `s.timestamp BETWEEN $1 AND $2`.
 *
 * `sales.timestamp` is TIMESTAMPTZ, but a bare 'YYYY-MM-DD' is cast using the
 * DATABASE session timezone (UTC in our containers) — not the merchant's. For
 * a UTC+2 store that shifted every period boundary two hours: the first two
 * hours of trading on the start day fell outside the report and two hours of
 * the following day fell inside it, so the same day read differently on the
 * dashboard cards (computed in browser-local time) and in the product table.
 *
 * Callers that know the exact instants — the dashboard, which derives both
 * bounds from the period picker — send full ISO-8601 timestamps WITH offset,
 * and those are used verbatim. Plain dates keep the previous behaviour so
 * existing callers and hand-built API requests are unaffected.
 */
export const periodBounds = (startDate: string, endDate: string): [string, string] => {
    const exact = (v: string) => typeof v === 'string' && v.includes('T');
    const start = exact(startDate) ? new Date(startDate).toISOString() : startDate;
    // An exact upper bound is EXCLUSIVE (it is the start of the next period),
    // so step back a millisecond for the inclusive BETWEEN. A plain date is an
    // inclusive calendar day, so it runs to that day's last millisecond.
    const end = exact(endDate)
        ? new Date(new Date(endDate).getTime() - 1).toISOString()
        : new Date(new Date(endDate).getTime() + 24 * 60 * 60 * 1000 - 1).toISOString();
    return [start, end];
};
