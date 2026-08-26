import db from '../db_client';
import { SessionTotals, num } from './cash-math';

// The arithmetic lives in ./cash-math, which imports no database. Re-exported
// here so callers have one place to reach for the till.
export { computeExpectedCash, computeVariance } from './cash-math';
export type { SessionTotals } from './cash-math';

/**
 * The till: what a cash drawer should hold, and what it actually holds.
 *
 * A POS that only records sales cannot answer the question an owner asks at the
 * end of the day — "is my cash right?". Answering it needs three things this
 * module provides: a declared opening float, every non-sale movement of money
 * across the drawer, and a closing count checked against what the books expect.
 *
 * The arithmetic is deliberately separated from the queries. It is the part
 * that must be right, and it is the part worth testing without a database.
 */

/** Payment methods that move notes and coins through the drawer. */
const CASH_METHOD = 'cash';

/**
 * Add up everything that happened at one till.
 *
 * Refunds subtract `exchange_credit_applied`, because an exchange refunds the
 * full value of what came back but only the part not spent on replacement goods
 * actually leaves the drawer. Counting the whole refund would show a shortage
 * on every exchange.
 */
export const loadSessionTotals = async (
    sessionId: string,
    storeId: string,
): Promise<SessionTotals> => {
    const [session, sales, refunds, movements] = await Promise.all([
        db.query(
            'SELECT opening_float FROM cash_sessions WHERE id = $1 AND store_id = $2',
            [sessionId, storeId],
        ),
        db.query(
            `SELECT COALESCE(SUM(p.amount), 0) AS total
               FROM payments p
               JOIN sales s ON s.transaction_id = p.sale_id
              WHERE s.cash_session_id = $1
                AND s.store_id = $2
                AND LOWER(p.method) = $3`,
            [sessionId, storeId, CASH_METHOD],
        ),
        db.query(
            `SELECT COALESCE(SUM(refund_amount - exchange_credit_applied), 0) AS total
               FROM returns
              WHERE cash_session_id = $1
                AND store_id = $2
                AND LOWER(refund_method) = $3`,
            [sessionId, storeId, CASH_METHOD],
        ),
        db.query(
            `SELECT
                COALESCE(SUM(amount) FILTER (WHERE type = 'pay_in'), 0)  AS pay_ins,
                COALESCE(SUM(amount) FILTER (WHERE type = 'pay_out'), 0) AS pay_outs
               FROM cash_movements
              WHERE session_id = $1 AND store_id = $2`,
            [sessionId, storeId],
        ),
    ]);

    return {
        openingFloat: num(session.rows[0]?.opening_float),
        cashSales: num(sales.rows[0]?.total),
        cashRefunds: num(refunds.rows[0]?.total),
        payIns: num(movements.rows[0]?.pay_ins),
        payOuts: num(movements.rows[0]?.pay_outs),
    };
};

/**
 * Takings at this till broken down by how they were paid.
 *
 * The non-cash rows do not affect the drawer, but they are what makes an X or Z
 * report a shift summary rather than just a cash count — an owner reading it
 * wants the day's trade, not only the notes in the tray.
 */
export const loadTenderBreakdown = async (
    sessionId: string,
    storeId: string,
): Promise<Array<{ method: string; amount: number; count: number }>> => {
    const { rows } = await db.query(
        `SELECT p.method,
                COALESCE(SUM(p.amount), 0) AS amount,
                COUNT(*)                   AS count
           FROM payments p
           JOIN sales s ON s.transaction_id = p.sale_id
          WHERE s.cash_session_id = $1 AND s.store_id = $2
          GROUP BY p.method
          ORDER BY amount DESC`,
        [sessionId, storeId],
    );
    return rows.map(r => ({
        method: String(r.method),
        amount: num(r.amount),
        count: Number(r.count) || 0,
    }));
};

/** How much trade passed through the till, for the report header. */
export const loadSaleCounts = async (
    sessionId: string,
    storeId: string,
): Promise<{ sales: number; returns: number; grossSales: number; noSaleOpens: number }> => {
    const [sales, returns, noSales] = await Promise.all([
        db.query(
            `SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS gross
               FROM sales WHERE cash_session_id = $1 AND store_id = $2`,
            [sessionId, storeId],
        ),
        db.query(
            'SELECT COUNT(*) AS count FROM returns WHERE cash_session_id = $1 AND store_id = $2',
            [sessionId, storeId],
        ),
        // Worth a line on the Z report: a drawer opened repeatedly without a
        // sale is the pattern this whole record exists to make visible.
        db.query(
            `SELECT COUNT(*) AS count FROM cash_movements
               WHERE session_id = $1 AND store_id = $2 AND type = 'no_sale'`,
            [sessionId, storeId],
        ),
    ]);
    return {
        sales: Number(sales.rows[0]?.count) || 0,
        returns: Number(returns.rows[0]?.count) || 0,
        grossSales: num(sales.rows[0]?.gross),
        noSaleOpens: Number(noSales.rows[0]?.count) || 0,
    };
};

/**
 * The till this user currently has open, if any.
 *
 * Used on every sale to stamp the transaction, so it is kept to a single
 * indexed lookup — a sale must not get slower because tills exist.
 */
export const findOpenSessionId = async (
    storeId: string,
    userId: string | undefined,
): Promise<string | null> => {
    if (!userId) return null;
    try {
        const { rows } = await db.query(
            `SELECT id FROM cash_sessions
              WHERE store_id = $1 AND opened_by_id = $2 AND status = 'open'
              LIMIT 1`,
            [storeId, userId],
        );
        return rows[0]?.id ?? null;
    } catch {
        // A till is bookkeeping, not a precondition for trading. If this lookup
        // fails the sale must still go through, unattributed.
        return null;
    }
};
