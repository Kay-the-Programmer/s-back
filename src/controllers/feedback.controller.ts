import express from 'express';
import db from '../db_client';
import { generateId, toCamelCase } from '../utils/helpers';
import { auditService } from '../services/audit.service';

const FEEDBACK_TYPES = ['bug', 'feature', 'improvement', 'praise', 'general'] as const;
const FEEDBACK_STATUSES = ['new', 'reviewing', 'planned', 'resolved', 'dismissed'] as const;

type FeedbackType = (typeof FEEDBACK_TYPES)[number];
type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/**
 * Submit a piece of feedback. Available to any authenticated user (store owners,
 * staff, customers). The author's identity + current store are captured from the
 * session so the Super Admin can see who said what, without trusting the client.
 */
export const submitFeedback = async (req: express.Request, res: express.Response) => {
    try {
        const user = req.user;
        if (!user) return res.status(401).json({ message: 'Not authenticated' });

        const { type, rating, subject, message, page, appVersion, platform } = req.body || {};

        const cleanMessage = typeof message === 'string' ? message.trim() : '';
        if (!cleanMessage) {
            return res.status(400).json({ message: 'A feedback message is required.' });
        }
        if (cleanMessage.length > 5000) {
            return res.status(400).json({ message: 'Feedback is too long (max 5000 characters).' });
        }

        const safeType: FeedbackType = FEEDBACK_TYPES.includes(type) ? type : 'general';

        let safeRating: number | null = null;
        if (rating !== undefined && rating !== null && rating !== '') {
            const r = Number(rating);
            if (Number.isFinite(r) && r >= 1 && r <= 5) safeRating = Math.round(r);
        }

        // Resolve the store name (best-effort) so the console can show it without a join.
        let storeName: string | null = null;
        const storeId = (user as any).currentStoreId || null;
        if (storeId) {
            try {
                const s = await db.query('SELECT name FROM stores WHERE id = $1', [storeId]);
                storeName = s.rows[0]?.name ?? null;
            } catch { /* non-fatal */ }
        }

        const id = generateId('fb');
        const result = await db.query(
            `INSERT INTO feedback
                (id, store_id, store_name, user_id, user_name, user_email, user_role,
                 type, rating, subject, message, page, app_version, platform, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'new')
             RETURNING *`,
            [
                id,
                storeId,
                storeName,
                user.id,
                user.name || null,
                user.email || null,
                (user as any).role || null,
                safeType,
                safeRating,
                subject ? String(subject).slice(0, 200) : null,
                cleanMessage,
                page ? String(page).slice(0, 300) : null,
                appVersion ? String(appVersion).slice(0, 60) : null,
                platform ? String(platform).slice(0, 30) : null,
            ]
        );

        return res.status(201).json(toCamelCase({ feedback: result.rows[0] }));
    } catch (e) {
        console.error('Error submitting feedback', e);
        return res.status(500).json({ message: 'Failed to submit feedback' });
    }
};

/**
 * List feedback (Super Admin). Supports filtering by status/type/rating and a
 * free-text search across subject/message/author. Returns newest first.
 */
export const listFeedback = async (req: express.Request, res: express.Response) => {
    try {
        const { status, type, rating, search } = req.query as Record<string, string>;
        const limit = Math.min(Number(req.query.limit) || 200, 500);

        const where: string[] = [];
        const params: any[] = [];

        if (status && FEEDBACK_STATUSES.includes(status as FeedbackStatus)) {
            params.push(status);
            where.push(`status = $${params.length}`);
        } else if (status === 'open') {
            // Convenience bucket: everything not yet closed out.
            where.push(`status NOT IN ('resolved','dismissed')`);
        }
        if (type && FEEDBACK_TYPES.includes(type as FeedbackType)) {
            params.push(type);
            where.push(`type = $${params.length}`);
        }
        if (rating) {
            const r = Number(rating);
            if (Number.isFinite(r) && r >= 1 && r <= 5) {
                params.push(r);
                where.push(`rating = $${params.length}`);
            }
        }
        if (search && search.trim()) {
            params.push(`%${search.trim().toLowerCase()}%`);
            const p = `$${params.length}`;
            where.push(`(LOWER(message) LIKE ${p} OR LOWER(COALESCE(subject,'')) LIKE ${p} OR LOWER(COALESCE(user_name,'')) LIKE ${p} OR LOWER(COALESCE(store_name,'')) LIKE ${p})`);
        }

        params.push(limit);
        const sql = `SELECT * FROM feedback ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${params.length}`;
        const result = await db.query(sql, params);

        return res.status(200).json(toCamelCase({ feedback: result.rows }));
    } catch (e) {
        console.error('Error listing feedback', e);
        return res.status(500).json({ message: 'Failed to list feedback' });
    }
};

/**
 * Aggregate feedback analytics for the Super Admin dashboard: totals, breakdowns
 * by status/type, average rating + distribution, and a 30-day submission trend.
 */
export const getFeedbackStats = async (_req: express.Request, res: express.Response) => {
    try {
        const [totals, byStatus, byType, ratingDist, trend] = await Promise.all([
            db.query(`
                SELECT
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status = 'new')::int AS new_count,
                    COUNT(*) FILTER (WHERE status NOT IN ('resolved','dismissed'))::int AS open_count,
                    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::int AS last7,
                    COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS last30,
                    COUNT(rating)::int AS rated_count,
                    COALESCE(ROUND(AVG(rating)::numeric, 2), 0) AS avg_rating
                FROM feedback
            `),
            db.query(`SELECT status, COUNT(*)::int AS count FROM feedback GROUP BY status`),
            db.query(`SELECT type, COUNT(*)::int AS count FROM feedback GROUP BY type`),
            db.query(`SELECT rating, COUNT(*)::int AS count FROM feedback WHERE rating IS NOT NULL GROUP BY rating ORDER BY rating`),
            db.query(`
                SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::int AS count
                FROM feedback
                WHERE created_at >= NOW() - INTERVAL '30 days'
                GROUP BY 1 ORDER BY 1
            `),
        ]);

        const statusMap: Record<string, number> = {};
        byStatus.rows.forEach(r => { statusMap[r.status] = r.count; });
        const typeMap: Record<string, number> = {};
        byType.rows.forEach(r => { typeMap[r.type] = r.count; });
        const ratingMap: Record<string, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        ratingDist.rows.forEach(r => { ratingMap[r.rating] = r.count; });

        const t = totals.rows[0] || {};
        return res.status(200).json(toCamelCase({
            stats: {
                total: t.total || 0,
                newCount: t.new_count || 0,
                openCount: t.open_count || 0,
                last7: t.last7 || 0,
                last30: t.last30 || 0,
                ratedCount: t.rated_count || 0,
                avgRating: Number(t.avg_rating) || 0,
                byStatus: statusMap,
                byType: typeMap,
                ratingDistribution: ratingMap,
                trend: trend.rows,
            },
        }));
    } catch (e) {
        console.error('Error computing feedback stats', e);
        return res.status(500).json({ message: 'Failed to compute feedback stats' });
    }
};

/**
 * Triage a piece of feedback (Super Admin): change its status and/or attach an
 * internal note. Records who resolved it when moved to a closed state.
 */
export const updateFeedback = async (req: express.Request, res: express.Response) => {
    try {
        const { id } = req.params;
        const { status, adminNotes } = req.body || {};

        const sets: string[] = ['updated_at = NOW()'];
        const params: any[] = [];

        if (status !== undefined) {
            if (!FEEDBACK_STATUSES.includes(status)) {
                return res.status(400).json({ message: 'Invalid status' });
            }
            params.push(status);
            sets.push(`status = $${params.length}`);

            if (status === 'resolved' || status === 'dismissed') {
                params.push(req.user!.id);
                sets.push(`resolved_by = $${params.length}`);
                sets.push(`resolved_at = NOW()`);
            } else {
                sets.push(`resolved_by = NULL`);
                sets.push(`resolved_at = NULL`);
            }
        }
        if (adminNotes !== undefined) {
            params.push(adminNotes ? String(adminNotes).slice(0, 2000) : null);
            sets.push(`admin_notes = $${params.length}`);
        }

        params.push(id);
        const result = await db.query(
            `UPDATE feedback SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
            params
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Feedback not found' });
        }

        await auditService.log(req.user!, 'Feedback Triaged', `Feedback ${id}${status ? ` → ${status}` : ''}`);
        return res.status(200).json(toCamelCase({ feedback: result.rows[0] }));
    } catch (e) {
        console.error('Error updating feedback', e);
        return res.status(500).json({ message: 'Failed to update feedback' });
    }
};
