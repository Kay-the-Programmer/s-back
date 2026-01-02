import express from 'express';
import { getAuditLogs } from '../controllers/audit.controller';
import { protect, adminOnly } from '../middleware/auth.middleware';

const router = express.Router();

router.get('/', protect, adminOnly, getAuditLogs);

export default router;