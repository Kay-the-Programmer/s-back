import { User, AuditLog } from '../types';
import db from '../db_client';
import { generateId } from '../utils/helpers';

type DBClient = { query: (text: string, params?: any[]) => Promise<any> };

export const auditService = {
    log: async (user: User, action: string, details: string, client?: DBClient) => {
        const dbClient = client || db;
        const id = generateId('log');
        
        const storeId = user.currentStoreId || (undefined as any);
        await dbClient.query(
            'INSERT INTO audit_logs (id, "timestamp", user_id, user_name, action, details, store_id) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [id, new Date().toISOString(), user.id, user.name, action, details, storeId]
        );
    }
};