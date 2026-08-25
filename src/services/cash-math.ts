/**
 * What a cash drawer should hold.
 *
 * Kept apart from the queries that feed it, and free of any database import, so
 * the part that must be arithmetically right can be tested on its own. Getting
 * this wrong does not throw — it tells a shopkeeper their cashier is short, or
 * hides that they are.
 */

export interface SessionTotals {
    openingFloat: number;
    /** Cash taken in over the counter. */
    cashSales: number;
    /** Cash handed back for returns — money that left the drawer. */
    cashRefunds: number;
    payIns: number;
    payOuts: number;
}

/**
 * Note what is deliberately absent: card, mobile money and on-account sales.
 * They are takings, but they never pass through the drawer, and counting them
 * would make every honest till look short by the day's card revenue.
 */
export const computeExpectedCash = (t: SessionTotals): number =>
    round2(
        num(t.openingFloat) + num(t.cashSales) - num(t.cashRefunds) + num(t.payIns) - num(t.payOuts),
    );

/**
 * Counted minus expected. Positive is a surplus, negative a shortage.
 *
 * Rounded before comparison: adding a day's takings in binary floating point
 * drifts, and a till reported as 0.0000000001 over is a till that looks wrong
 * to the one person who most needs to trust it.
 */
export const computeVariance = (counted: number, expected: number): number =>
    round2(num(counted) - num(expected));

export const round2 = (n: number): number =>
    Math.round((num(n) + Number.EPSILON) * 100) / 100;

/** NUMERIC columns arrive parsed, but a null sum must not poison the total. */
export const num = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    return Number.isFinite(n) ? n : 0;
};
