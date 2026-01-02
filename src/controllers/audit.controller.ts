import express from 'express';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';

export const getAuditLogs = async (req: express.Request, res: express.Response) => {
    const { userId, action, startDate, endDate } = req.query as { [key: string]: string };

    const storeId = (req as any).tenant?.storeId || req.user?.currentStoreId;
    if (!storeId) {
        return res.status(400).json({ message: 'Store context required' });
    }

    let query = 'SELECT * FROM audit_logs';
    const params: any[] = [];
    const whereClauses: string[] = [];

    // Enforce store isolation
    params.push(storeId);
    whereClauses.push(`store_id = $${params.length}`);

    if (userId) {
        params.push(userId);
        whereClauses.push(`user_id = $${params.length}`);
    }
    if (action) {
        params.push(`%${action}%`);
        whereClauses.push(`action ILIKE $${params.length}`);
    }
    if (startDate) {
        params.push(startDate);
        whereClauses.push(`"timestamp" >= $${params.length}`);
    }
    if (endDate) {
        params.push(endDate);
        whereClauses.push(`"timestamp" <= $${params.length}`);
    }

    if (whereClauses.length > 0) {
        query += ' WHERE ' + whereClauses.join(' AND ');
    }

    query += ' ORDER BY "timestamp" DESC LIMIT 100'; // Add a limit to prevent huge responses

    try {
        const result = await db.query(query, params);
        res.status(200).json(toCamelCase(result.rows));
    } catch (error) {
        console.error('Error fetching audit logs:', error);
        res.status(500).json({ message: 'Error fetching audit logs' });
    }
};