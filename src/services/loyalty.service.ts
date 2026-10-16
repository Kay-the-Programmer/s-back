import db from '../db_client';
import { generateId } from '../utils/helpers';

/**
 * Loyalty points as an append-only ledger.
 *
 * Points used to be DERIVED at read time as `floor(lifetime spend / earn rate)`,
 * so changing the earn rate re-priced every customer's existing balance — raise
 * the rate and a balance someone was told they had shrinks, possibly below what
 * they have already redeemed. Here a row is written when the sale happens, at
 * the rate in force AT THAT MOMENT, and nothing recomputes it afterwards. A
 * return writes a negative row against the same sale, reversing at that sale's
 * own historical rate rather than today's.
 */

/** Anything that can run a query: the pool, or a client inside a transaction. */
export interface Queryable {
    query: (text: string, params?: any[]) => Promise<any>;
}

export const DEFAULT_EARN_SPEND_PER_POINT = 10;

/**
 * The store's earn rate, or the default when the program has never been
 * configured (which is also what `GET /crm/loyalty/program` reports).
 * Returns 0 when the program is switched off — no points are awarded then.
 */
export const getEarnRate = async (storeId: string, client: Queryable = db): Promise<number> => {
    const result = await client.query(
        'SELECT enabled, earn_spend_per_point FROM loyalty_programs WHERE store_id = $1',
        [storeId],
    );
    if (result.rowCount === 0) return DEFAULT_EARN_SPEND_PER_POINT; // unconfigured = active defaults
    if (!result.rows[0].enabled) return 0;
    const rate = Number(result.rows[0].earn_spend_per_point);
    return Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_EARN_SPEND_PER_POINT;
};

/**
 * Award points for an attributed sale. Best-effort by design: it runs inside
 * the sale's own transaction, and a loyalty problem must never cost the store
 * the sale, so a failure is logged and swallowed by the caller's try/catch
 * policy rather than rolled back into it.
 *
 * Idempotent — a retried sale (same transactionId) hits the unique index on
 * `sale_id` and is ignored.
 */
export const awardPointsForSale = async (
    opts: { storeId: string; customerId?: string | null; saleId: string; total: number; earnedAt?: string },
    client: Queryable = db,
): Promise<number> => {
    if (!opts.customerId || !opts.storeId) return 0;
    const amount = Number(opts.total) || 0;
    if (amount <= 0) return 0;

    const rate = await getEarnRate(opts.storeId, client);
    if (rate <= 0) return 0; // program paused

    const points = Math.floor(amount / rate);
    if (points <= 0) return 0;

    await client.query(
        `INSERT INTO loyalty_points (id, store_id, customer_id, sale_id, reason, points, earn_spend_per_point, basis_amount, earned_at)
         VALUES ($1,$2,$3,$4,'sale',$5,$6,$7,COALESCE($8::timestamptz, NOW()))
         ON CONFLICT DO NOTHING`,
        [generateId('lpt'), opts.storeId, opts.customerId, opts.saleId, points, rate, amount, opts.earnedAt || null],
    );
    return points;
};

/**
 * Reverse points when a sale is refunded, in proportion to the refund and at
 * the ORIGINAL sale's rate (read from its own earn row), so a rate change
 * between the sale and the return cannot make a refund claw back more — or
 * less — than was actually given. Capped so repeated partial returns can never
 * reverse more than the sale earned.
 */
export const reversePointsForReturn = async (
    opts: { storeId: string; saleId: string; returnId: string; refundAmount: number; saleTotal: number; returnedAt?: string },
    client: Queryable = db,
): Promise<number> => {
    const refund = Number(opts.refundAmount) || 0;
    const total = Number(opts.saleTotal) || 0;
    if (refund <= 0 || total <= 0) return 0;

    const earned = await client.query(
        `SELECT customer_id, points, earn_spend_per_point FROM loyalty_points
          WHERE sale_id = $1 AND store_id = $2 AND reason IN ('sale','backfill')`,
        [opts.saleId, opts.storeId],
    );
    if (earned.rowCount === 0) return 0;
    const row = earned.rows[0];
    const awarded = Number(row.points) || 0;
    if (awarded <= 0) return 0;

    const alreadyReversed = await client.query(
        `SELECT COALESCE(SUM(-points), 0) AS reversed FROM loyalty_points
          WHERE sale_id = $1 AND store_id = $2 AND reason IN ('return','adjustment')`,
        [opts.saleId, opts.storeId],
    );
    const reversible = Math.max(0, awarded - (Number(alreadyReversed.rows[0].reversed) || 0));
    if (reversible <= 0) return 0;

    const points = Math.min(reversible, Math.round(awarded * (refund / total)));
    if (points <= 0) return 0;

    await client.query(
        `INSERT INTO loyalty_points (id, store_id, customer_id, sale_id, return_id, reason, points, earn_spend_per_point, basis_amount, earned_at)
         VALUES ($1,$2,$3,$4,$5,'return',$6,$7,$8,COALESCE($9::timestamptz, NOW()))
         ON CONFLICT DO NOTHING`,
        [generateId('lpt'), opts.storeId, row.customer_id, opts.saleId, opts.returnId,
            -points, row.earn_spend_per_point, refund, opts.returnedAt || null],
    );
    return points;
};

/**
 * Take back everything a sale is still holding, for a sale that is being
 * cancelled outright (an online order that was never paid for, manually or by
 * the stale-order job). The old derived balance counted cancelled orders as
 * spend, so this also fixes points being earned for goods that went back on
 * the shelf.
 */
export const voidPointsForSale = async (
    opts: { storeId: string; saleId: string },
    client: Queryable = db,
): Promise<number> => {
    const result = await client.query(
        `SELECT customer_id, COALESCE(SUM(points), 0) AS points, MAX(earn_spend_per_point) AS rate
           FROM loyalty_points WHERE sale_id = $1 AND store_id = $2
          GROUP BY customer_id`,
        [opts.saleId, opts.storeId],
    );
    if (result.rowCount === 0) return 0;
    const row = result.rows[0];
    const outstanding = Number(row.points) || 0;
    if (outstanding <= 0) return 0;

    await client.query(
        `INSERT INTO loyalty_points (id, store_id, customer_id, sale_id, reason, points, earn_spend_per_point, basis_amount)
         VALUES ($1,$2,$3,$4,'adjustment',$5,$6,0)`,
        [generateId('lpt'), opts.storeId, row.customer_id, opts.saleId, -outstanding, row.rate],
    );
    return outstanding;
};

/** Lifetime points earned (net of return reversals) for one customer. */
export const getPointsEarned = async (storeId: string, customerId: string, client: Queryable = db): Promise<number> => {
    const result = await client.query(
        'SELECT COALESCE(SUM(points), 0) AS points FROM loyalty_points WHERE store_id = $1 AND customer_id = $2',
        [storeId, customerId],
    );
    return Math.max(0, Number(result.rows[0].points) || 0);
};
