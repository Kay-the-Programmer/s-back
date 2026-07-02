import express from 'express';
import db from '../db_client';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Idempotency guard for write requests that carry an `X-Idempotency-Key` header.
 *
 * The offline-capable clients (web / desktop / mobile) attach a stable key to
 * every queued mutation, so a write replayed after a response was lost on a
 * flaky network is applied **at most once**:
 *
 *   - The first request with a given key claims it, runs the handler, and caches
 *     the SUCCESS (2xx) response.
 *   - A later request with the same key replays the cached response verbatim
 *     instead of re-executing the handler (so a sale/product isn't created
 *     twice). The replay carries an `Idempotent-Replay: true` header.
 *   - Non-2xx responses release the key, so a genuinely failed write can be
 *     retried cleanly.
 *   - A duplicate that arrives while the original is still in flight gets `429`
 *     (the clients treat 429 as "retry later"), so it re-checks once the first
 *     request has finished and cached its result.
 *
 * Mounted globally before the API routes. Requests without the header — and all
 * non-mutating methods — pass straight through, so existing behaviour is
 * unchanged unless a client opts in by sending the key.
 */
export const idempotency = async (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
) => {
    const key = req.header('x-idempotency-key');
    if (!key || !MUTATING.has(req.method.toUpperCase())) {
        return next();
    }

    try {
        // Atomically claim the key. ON CONFLICT DO NOTHING → rowCount 0 means
        // the key already exists (completed or in-flight).
        const claim = await db.query(
            `INSERT INTO idempotency_keys (key, method, path)
             VALUES ($1, $2, $3)
             ON CONFLICT (key) DO NOTHING
             RETURNING key`,
            [key, req.method.toUpperCase(), req.originalUrl],
        );

        if (claim.rowCount === 0) {
            const existing = await db.query(
                'SELECT status_code, response_body FROM idempotency_keys WHERE key = $1',
                [key],
            );
            const row = existing.rows[0];
            if (row && row.status_code != null) {
                // Completed before → replay the cached response.
                res.setHeader('Idempotent-Replay', 'true');
                return res.status(row.status_code).json(row.response_body);
            }
            // Claimed but not finished → a concurrent duplicate is in flight.
            // 429 tells the offline clients to back off and retry, by which time
            // the original has cached its result.
            res.setHeader('Retry-After', '2');
            return res.status(429).json({
                message: 'A duplicate request is already being processed.',
                code: 'IDEMPOTENCY_IN_PROGRESS',
            });
        }
    } catch (e) {
        // Never block a write because the idempotency store hiccuped — degrade
        // to non-idempotent behaviour rather than failing the request.
        console.error('[idempotency] claim failed:', e);
        return next();
    }

    // We own the key for this request: capture the outcome to cache it (on
    // success) or release it (on failure / non-JSON response).
    const originalJson = res.json.bind(res);
    let finalized = false;

    res.json = (body: any) => {
        finalized = true;
        const status = res.statusCode;
        if (status >= 200 && status < 300) {
            db.query(
                'UPDATE idempotency_keys SET status_code = $1, response_body = $2 WHERE key = $3',
                [status, body === undefined ? null : JSON.stringify(body), key],
            ).catch((err) => console.error('[idempotency] store failed:', err));
        } else {
            db.query('DELETE FROM idempotency_keys WHERE key = $1', [key])
                .catch((err) => console.error('[idempotency] release failed:', err));
        }
        return originalJson(body);
    };

    // If the handler ends the response without res.json (res.send/end, or an
    // unhandled error), release the claim so it isn't stuck "in progress".
    res.on('finish', () => {
        if (!finalized) {
            db.query('DELETE FROM idempotency_keys WHERE key = $1', [key]).catch(() => {
                /* best effort */
            });
        }
    });

    // Opportunistically purge keys older than 7 days (~1% of guarded requests)
    // so the table stays bounded without needing a separate scheduled job.
    if (Math.random() < 0.01) {
        db.query(`DELETE FROM idempotency_keys WHERE created_at < NOW() - INTERVAL '7 days'`).catch(() => {
            /* best effort */
        });
    }

    next();
};
