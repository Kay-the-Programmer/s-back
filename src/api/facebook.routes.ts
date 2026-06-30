import express from 'express';
import {
    getStatus, connect, selectPage, setEnabled, disconnect,
    publishPost, getPosts, getComments, replyComment, hideComment, deleteComment, getInsights,
} from '../controllers/facebook.controller';
import { protect, requirePermission } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect);

// Read (visible to staff): status, posts, comments, insights.
router.get('/status', requirePermission('settings:read'), getStatus);
router.get('/posts', requirePermission('settings:read'), getPosts);
router.get('/posts/:postId/comments', requirePermission('settings:read'), getComments);
router.get('/insights', requirePermission('settings:read'), getInsights);

// Manage (store admins): connect, publish, moderate.
router.post('/connect', requirePermission('settings:manage'), connect);
router.post('/select-page', requirePermission('settings:manage'), selectPage);
router.put('/enabled', requirePermission('settings:manage'), setEnabled);
router.post('/disconnect', requirePermission('settings:manage'), disconnect);
router.post('/publish', requirePermission('settings:manage'), publishPost);
router.post('/comments/:commentId/reply', requirePermission('settings:manage'), replyComment);
router.post('/comments/:commentId/hide', requirePermission('settings:manage'), hideComment);
router.delete('/comments/:commentId', requirePermission('settings:manage'), deleteComment);

export default router;
