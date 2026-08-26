import express from 'express';
import db from '../db_client';
import { generateId } from '../utils/helpers';
import { auditService } from '../services/audit.service';
import { roleHasPermission, Role } from '../auth/rbac';
import { requiresOverride } from '../services/override-rules';
import {
    OverrideError,
    canSelfAuthorize,
    consumeOverride,
    loadThresholds,
} from '../services/override.service';
import {
    computeExpectedCash,
    computeVariance,
    loadSaleCounts,
    loadSessionTotals,
    loadTenderBreakdown,
} from '../services/cash-session.service';

/**
 * The cash drawer, as a shift.
 *
 * Two audiences, deliberately given different views. A cashier may run their
 * own till but is never shown what it is expected to hold — a count made
 * against a known target is not a check on anything. Only `cash:manage` sees
 * the expected figure, and only once a count is committed does the cashier
 * learn whether they were over or short.
 */

const storeOf = (req: express.Request): string | undefined =>
    (req as any).tenant?.storeId;

const canManage = (req: express.Request): boolean =>
    roleHasPermission(req.user?.role as Role | undefined, 'cash:manage');

/** Money off the wire: reject anything that is not a sane, finite amount. */
const parseAmount = (raw: unknown): number | null => {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
    if (!Number.isFinite(n) || n < 0) return null;
    // A ceiling no real drawer reaches: a typo of six extra zeros should be
    // refused, not recorded as a vast surplus.
    if (n > 100000000) return null;
    return Math.round((n + Number.EPSILON) * 100) / 100;
};

const shape = (row: any) => ({
    id: row.id,
    storeId: row.store_id,
    openedBy: row.opened_by,
    openedById: row.opened_by_id,
    openedAt: row.opened_at,
    openingFloat: Number(row.opening_float) || 0,
    closedBy: row.closed_by,
    closedById: row.closed_by_id,
    closedAt: row.closed_at,
    countedCash: row.counted_cash === null ? null : Number(row.counted_cash),
    expectedCash: row.expected_cash === null ? null : Number(row.expected_cash),
    variance: row.variance === null ? null : Number(row.variance),
    status: row.status,
    notes: row.notes,
});

const movementsOf = async (sessionId: string) => {
    const { rows } = await db.query(
        `SELECT id, type, amount, reason, created_at, created_by
           FROM cash_movements WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId],
    );
    return rows.map(r => ({
        id: r.id,
        type: r.type,
        amount: Number(r.amount) || 0,
        reason: r.reason,
        createdAt: r.created_at,
        createdBy: r.created_by,
    }));
};

/**
 * The session named in the path, if the caller may touch it.
 *
 * A cashier reaches only their own open till; a manager reaches any in the store.
 */
const openSessionFor = async (req: express.Request, storeId: string) => {
    const { rows } = await db.query(
        'SELECT * FROM cash_sessions WHERE id = $1 AND store_id = $2',
        [req.params.id, storeId],
    );
    const row = rows[0];
    if (!row || row.status !== 'open') return null;
    if (!canManage(req) && row.opened_by_id !== req.user?.id) return null;
    return shape(row);
};

/**
 * The caller's own open till.
 *
 * Carries the movements and the trade so far, but NOT the expected cash — see
 * the note at the top of this file.
 */
export const getCurrentSession = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const { rows } = await db.query(
            `SELECT * FROM cash_sessions
              WHERE store_id = $1 AND opened_by_id = $2 AND status = 'open' LIMIT 1`,
            [storeId, req.user?.id ?? null],
        );
        if (!rows.length) return res.json(null);

        const session = shape(rows[0]);
        const counts = await loadSaleCounts(session.id, storeId);
        return res.json({
            ...session,
            expectedCash: null,
            movements: await movementsOf(session.id),
            ...counts,
        });
    } catch (e: any) {
        console.error('getCurrentSession failed:', e?.message);
        return res.status(500).json({ message: 'Could not load the till.' });
    }
};

/** Open a till with a counted float. */
export const openSession = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const openingFloat = parseAmount(req.body?.openingFloat ?? 0);
        if (openingFloat === null) {
            return res.status(400).json({ message: 'Enter the opening float as a number.' });
        }

        const id = generateId('TILL');
        try {
            const { rows } = await db.query(
                `INSERT INTO cash_sessions
                    (id, store_id, opened_by, opened_by_id, opened_at, opening_float, status)
                 VALUES ($1, $2, $3, $4, NOW(), $5, 'open')
                 RETURNING *`,
                [id, storeId, req.user?.name || 'Unknown', req.user?.id ?? null, openingFloat],
            );
            await auditService.log(
                req.user!,
                'Till Opened',
                `Session ${id} opened with a float of ${openingFloat.toFixed(2)}`,
            );
            return res.status(201).json({
                ...shape(rows[0]), movements: [], sales: 0, returns: 0, grossSales: 0, noSaleOpens: 0,
            });
        } catch (e: any) {
            // The partial unique index is the authority here, not a prior
            // SELECT — two taps on Open arrive together and both would pass a
            // check-then-insert.
            if (e?.code === '23505') {
                return res.status(409).json({
                    message: 'You already have a till open. Close it before opening another.',
                });
            }
            throw e;
        }
    } catch (e: any) {
        console.error('openSession failed:', e?.message);
        return res.status(500).json({ message: 'Could not open the till.' });
    }
};

/** Record money in or out that is not a sale. */
export const addMovement = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const type = req.body?.type;
        if (type !== 'pay_in' && type !== 'pay_out') {
            return res.status(400).json({ message: 'Movement must be a pay in or a pay out.' });
        }
        const amount = parseAmount(req.body?.amount);
        if (amount === null || amount <= 0) {
            return res.status(400).json({ message: 'Enter an amount greater than zero.' });
        }
        const reason = String(req.body?.reason ?? '').trim();
        if (!reason) {
            // Required on purpose: an unexplained movement is indistinguishable
            // from a shortage when someone reviews the shift a week later.
            return res.status(400).json({ message: 'Say what the money was for.' });
        }

        const session = await openSessionFor(req, storeId);
        if (!session) return res.status(404).json({ message: 'That till is not open.' });

        // Taking money out of the drawer is the one movement that can hide a
        // theft behind a plausible reason, so past the store's limit it takes a
        // manager. Paying money in needs nobody: it can only make the drawer
        // count right.
        if (type === 'pay_out' && !canSelfAuthorize(req.user?.role)) {
            const thresholds = await loadThresholds(storeId);
            if (requiresOverride('pay_out', amount, thresholds)) {
                try {
                    const { authorizedBy } = await consumeOverride({
                        overrideId: req.body?.overrideId,
                        storeId,
                        action: 'pay_out',
                        amount,
                    });
                    await auditService.log(
                        req.user!,
                        'Pay Out Override Used',
                        `${amount.toFixed(2)} out of ${session.id}, approved by ${authorizedBy}`,
                    );
                } catch (e) {
                    if (e instanceof OverrideError) {
                        return res.status(403).json({
                            message: e.message,
                            requiresOverride: 'pay_out',
                            amount,
                        });
                    }
                    throw e;
                }
            }
        }

        await db.query(
            `INSERT INTO cash_movements
                (id, session_id, store_id, type, amount, reason, created_at, created_by, created_by_id)
             VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8)`,
            [generateId('CASHMV'), session.id, storeId, type, amount, reason.slice(0, 300),
             req.user?.name || 'Unknown', req.user?.id ?? null],
        );
        await auditService.log(
            req.user!,
            type === 'pay_in' ? 'Till Pay In' : 'Till Pay Out',
            `${amount.toFixed(2)} - ${reason.slice(0, 120)} (session ${session.id})`,
        );
        return res.status(201).json({ movements: await movementsOf(session.id) });
    } catch (e: any) {
        console.error('addMovement failed:', e?.message);
        return res.status(500).json({ message: 'Could not record the movement.' });
    }
};

/**
 * Open the drawer without a sale.
 *
 * The pulse itself is a printer command the till sends directly, so nothing
 * server-side could stop a drawer opening. What this does is make it leave a
 * mark: the till asks first, and only opens the drawer if the answer is yes.
 * An unexplained drawer opening is how cash walks out of a shop, and until
 * now it was the one thing at the counter that left no trace at all.
 */
export const recordNoSale = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const session = await openSessionFor(req, storeId);
        if (!session) return res.status(404).json({ message: 'Open a till before using the drawer.' });

        const reason = String(req.body?.reason ?? '').trim();

        if (!canSelfAuthorize(req.user?.role)) {
            const thresholds = await loadThresholds(storeId);
            if (requiresOverride('no_sale', 0, thresholds)) {
                try {
                    const { authorizedBy } = await consumeOverride({
                        overrideId: req.body?.overrideId,
                        storeId,
                        action: 'no_sale',
                        amount: 0,
                    });
                    await auditService.log(
                        req.user!,
                        'No Sale Override Used',
                        `Drawer opened on ${session.id}, approved by ${authorizedBy}`,
                    );
                } catch (e) {
                    if (e instanceof OverrideError) {
                        return res.status(403).json({
                            message: e.message,
                            requiresOverride: 'no_sale',
                            amount: 0,
                        });
                    }
                    throw e;
                }
            }
        }

        await db.query(
            `INSERT INTO cash_movements
                (id, session_id, store_id, type, amount, reason, created_at, created_by, created_by_id)
             VALUES ($1, $2, $3, 'no_sale', 0, $4, NOW(), $5, $6)`,
            [generateId('NOSALE'), session.id, storeId, reason.slice(0, 300) || 'No sale',
             req.user?.name || 'Unknown', req.user?.id ?? null],
        );
        await auditService.log(
            req.user!,
            'Drawer Opened (No Sale)',
            `${session.id}${reason ? ` — ${reason.slice(0, 120)}` : ''}`,
        );
        return res.status(201).json({ ok: true });
    } catch (e: any) {
        console.error('recordNoSale failed:', e?.message);
        return res.status(500).json({ message: 'Could not record that.' });
    }
};

/**
 * The X report — a mid-shift read that changes nothing.
 *
 * Manager-only, and that is the point rather than an oversight: it reveals the
 * expected cash, and a cashier who sees the target before counting can make the
 * count agree with it.
 */
export const getSessionReport = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const { rows } = await db.query(
            'SELECT * FROM cash_sessions WHERE id = $1 AND store_id = $2',
            [req.params.id, storeId],
        );
        if (!rows.length) return res.status(404).json({ message: 'Till session not found.' });
        const session = shape(rows[0]);

        const totals = await loadSessionTotals(session.id, storeId);
        const [tenders, counts, movements] = await Promise.all([
            loadTenderBreakdown(session.id, storeId),
            loadSaleCounts(session.id, storeId),
            movementsOf(session.id),
        ]);

        return res.json({
            ...session,
            // A closed session reports what was found at the time; an open one
            // is computed live.
            expectedCash: session.status === 'closed'
                ? session.expectedCash
                : computeExpectedCash(totals),
            totals,
            tenders,
            movements,
            ...counts,
        });
    } catch (e: any) {
        console.error('getSessionReport failed:', e?.message);
        return res.status(500).json({ message: 'Could not build the till report.' });
    }
};

/**
 * The Z report — count the drawer and close the shift.
 *
 * The count arrives before any expected figure goes out, which is what makes it
 * a blind count. The three figures are then frozen onto the row: a Z report
 * records what was found at the time, and recomputing it later from sales since
 * refunded would quietly rewrite it.
 */
export const closeSession = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const countedCash = parseAmount(req.body?.countedCash);
        if (countedCash === null) {
            return res.status(400).json({ message: 'Count the drawer and enter the total.' });
        }

        const session = await openSessionFor(req, storeId);
        if (!session) return res.status(404).json({ message: 'That till is not open.' });

        const totals = await loadSessionTotals(session.id, storeId);
        const expectedCash = computeExpectedCash(totals);
        const variance = computeVariance(countedCash, expectedCash);

        const { rows } = await db.query(
            `UPDATE cash_sessions
                SET status = 'closed', closed_at = NOW(), closed_by = $1, closed_by_id = $2,
                    counted_cash = $3, expected_cash = $4, variance = $5, notes = $6
              WHERE id = $7 AND store_id = $8 AND status = 'open'
              RETURNING *`,
            [req.user?.name || 'Unknown', req.user?.id ?? null, countedCash, expectedCash, variance,
             String(req.body?.notes ?? '').trim().slice(0, 500) || null, session.id, storeId],
        );
        // The status guard in the UPDATE is what makes a double-submit safe:
        // the second one matches no row rather than closing the till twice.
        if (!rows.length) return res.status(409).json({ message: 'That till was already closed.' });

        await auditService.log(
            req.user!,
            'Till Closed',
            `Session ${session.id}: counted ${countedCash.toFixed(2)}, ` +
                `expected ${expectedCash.toFixed(2)}, variance ${variance.toFixed(2)}`,
        );

        const [tenders, counts, movements] = await Promise.all([
            loadTenderBreakdown(session.id, storeId),
            loadSaleCounts(session.id, storeId),
            movementsOf(session.id),
        ]);
        return res.json({ ...shape(rows[0]), totals, tenders, movements, ...counts });
    } catch (e: any) {
        console.error('closeSession failed:', e?.message);
        return res.status(500).json({ message: 'Could not close the till.' });
    }
};

/** Past sessions, newest first. Without cash:manage a cashier sees only theirs. */
export const listSessions = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
        const mineOnly = !canManage(req);
        const { rows } = await db.query(
            `SELECT * FROM cash_sessions
              WHERE store_id = $1 ${mineOnly ? 'AND opened_by_id = $3' : ''}
              ORDER BY opened_at DESC LIMIT $2`,
            mineOnly ? [storeId, limit, req.user?.id ?? null] : [storeId, limit],
        );
        return res.json(rows.map(shape));
    } catch (e: any) {
        console.error('listSessions failed:', e?.message);
        return res.status(500).json({ message: 'Could not load till history.' });
    }
};
