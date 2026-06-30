import express from 'express';
import facebookService, { FACEBOOK_APP_ID } from '../services/facebook.service';
import { MODULES, isModuleEnabled } from '../services/entitlements.service';
import { auditService } from '../services/audit.service';

/**
 * DEV OVERRIDE: Social Marketing is free while the team builds/tests, mirroring
 * WHATSAPP_FREE. Defaults to FREE; set SOCIAL_FREE=false (and VITE_SOCIAL_FREE=false
 * on the frontend) to re-enable the paid add-on.
 */
const SOCIAL_FREE = process.env.SOCIAL_FREE !== 'false';

const isSocialEntitled = async (storeId?: string | null): Promise<boolean> =>
    SOCIAL_FREE || isModuleEnabled(storeId, MODULES.SOCIAL_MARKETING);

const requireEntitled = async (req: express.Request, res: express.Response): Promise<string | null> => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) { res.status(400).json({ message: 'No store selected.' }); return null; }
    if (!(await isSocialEntitled(storeId))) {
        res.status(402).json({
            message: 'Social Marketing is a premium feature. Unlock it to manage your Facebook Page.',
            code: 'MODULE_LOCKED',
            module: MODULES.SOCIAL_MARKETING,
        });
        return null;
    }
    return storeId;
};

// --- Status ---

export const getStatus = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = req.user?.currentStoreId;
        const entitled = await isSocialEntitled(storeId);
        let connected = false, enabled = false;
        let pageId: string | null = null, pageName: string | null = null;
        if (storeId) {
            const config = await facebookService.getStoreConfig(storeId);
            if (config) {
                connected = !!(config.page_id && config.page_access_token);
                enabled = !!config.is_enabled;
                pageId = config.page_id;
                pageName = config.page_name;
            }
        }
        // appId + configured tell the frontend whether the FB SDK can run at all.
        res.json({ configured: !!FACEBOOK_APP_ID, appId: FACEBOOK_APP_ID, entitled, connected, enabled, pageId, pageName });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch Facebook status' });
    }
};

// --- OAuth / connection ---

export const connect = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    const { accessToken } = req.body as { accessToken?: string };
    if (!accessToken) return res.status(400).json({ message: 'A Facebook access token is required.' });

    try {
        const longLived = await facebookService.exchangeForLongLivedToken(accessToken);
        const pages = await facebookService.getUserPages(longLived);
        if (pages.length === 0) {
            return res.status(400).json({ message: 'No Facebook Pages found. Make sure you granted access to a Page you manage.' });
        }
        await facebookService.saveUserToken(storeId, longLived);

        // One Page → connect it automatically. Multiple → let the user choose.
        if (pages.length === 1) {
            const p = pages[0];
            await facebookService.saveConnection(storeId, {
                pageId: p.id, pageName: p.name, pageAccessToken: p.access_token,
                userAccessToken: longLived, instagramBusinessId: p.instagram_business_id,
            });
            if (req.user) auditService.log(req.user, 'Facebook Connected', `Page ${p.name}`).catch(() => { });
            return res.json({ connected: true, page: { id: p.id, name: p.name }, pages: [{ id: p.id, name: p.name }] });
        }
        res.json({ connected: false, pages: pages.map(p => ({ id: p.id, name: p.name, instagram_business_id: p.instagram_business_id })) });
    } catch (error: any) {
        res.status(502).json({ message: error.message || 'Failed to connect Facebook.' });
    }
};

export const selectPage = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    const { pageId } = req.body as { pageId?: string };
    if (!pageId) return res.status(400).json({ message: 'A pageId is required.' });

    try {
        const config = await facebookService.getStoreConfig(storeId);
        if (!config?.user_access_token) return res.status(400).json({ message: 'Connect Facebook first.' });
        const pages = await facebookService.getUserPages(config.user_access_token);
        const page = pages.find(p => p.id === pageId);
        if (!page) return res.status(404).json({ message: 'That Page is no longer available on your account.' });

        await facebookService.saveConnection(storeId, {
            pageId: page.id, pageName: page.name, pageAccessToken: page.access_token,
            userAccessToken: config.user_access_token, instagramBusinessId: page.instagram_business_id,
        });
        if (req.user) auditService.log(req.user, 'Facebook Connected', `Page ${page.name}`).catch(() => { });
        res.json({ connected: true, page: { id: page.id, name: page.name } });
    } catch (error: any) {
        res.status(502).json({ message: error.message || 'Failed to select the Page.' });
    }
};

export const setEnabled = async (req: express.Request, res: express.Response) => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'No store selected.' });
    try {
        await facebookService.setEnabled(storeId, req.body?.enabled !== false);
        res.json({ message: 'Updated' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update.' });
    }
};

export const disconnect = async (req: express.Request, res: express.Response) => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'No store selected.' });
    try {
        await facebookService.disconnect(storeId);
        if (req.user) auditService.log(req.user, 'Facebook Disconnected', '').catch(() => { });
        res.json({ message: 'Disconnected' });
    } catch (error) {
        res.status(500).json({ message: 'Failed to disconnect.' });
    }
};

// --- Page operations ---

export const publishPost = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    const { message, link, imageUrl } = req.body as { message?: string; link?: string; imageUrl?: string };
    if (!message?.trim() && !imageUrl) return res.status(400).json({ message: 'Add a message or an image to publish.' });
    try {
        const result = await facebookService.publishPost(storeId, { message, link, imageUrl });
        if (req.user) auditService.log(req.user, 'Facebook Post Published', message?.slice(0, 80) || 'photo').catch(() => { });
        res.json({ success: true, ...result });
    } catch (error: any) {
        res.status(502).json({ success: false, message: error.message || 'Failed to publish.' });
    }
};

export const getPosts = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    try {
        res.json(await facebookService.getPosts(storeId));
    } catch (error: any) {
        res.status(502).json({ message: error.message || 'Failed to load posts.' });
    }
};

export const getComments = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    try {
        res.json(await facebookService.getComments(storeId, req.params.postId));
    } catch (error: any) {
        res.status(502).json({ message: error.message || 'Failed to load comments.' });
    }
};

export const replyComment = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    const { message } = req.body as { message?: string };
    if (!message?.trim()) return res.status(400).json({ message: 'A reply message is required.' });
    try {
        res.json({ success: true, ...(await facebookService.replyToComment(storeId, req.params.commentId, message.trim())) });
    } catch (error: any) {
        res.status(502).json({ success: false, message: error.message || 'Failed to reply.' });
    }
};

export const hideComment = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    try {
        await facebookService.setCommentHidden(storeId, req.params.commentId, req.body?.hidden !== false);
        res.json({ success: true });
    } catch (error: any) {
        res.status(502).json({ success: false, message: error.message || 'Failed to update comment.' });
    }
};

export const deleteComment = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    try {
        await facebookService.deleteComment(storeId, req.params.commentId);
        res.json({ success: true });
    } catch (error: any) {
        res.status(502).json({ success: false, message: error.message || 'Failed to delete comment.' });
    }
};

export const getInsights = async (req: express.Request, res: express.Response) => {
    const storeId = await requireEntitled(req, res);
    if (!storeId) return;
    try {
        res.json(await facebookService.getInsights(storeId));
    } catch (error: any) {
        res.status(502).json({ message: error.message || 'Failed to load insights.' });
    }
};
