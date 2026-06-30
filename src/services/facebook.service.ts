import axios from 'axios';
import crypto from 'crypto';
import CryptoJS from 'crypto-js';
import db from '../db_client';

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'default-secret-key-change-in-prod';
const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${GRAPH_VERSION}`;

export const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';

export interface FacebookConfig {
    store_id: string;
    page_id: string | null;
    page_name: string | null;
    page_access_token: string | null;
    user_access_token: string | null;
    instagram_business_id: string | null;
    is_enabled: boolean;
    connected_at: string | null;
}

export interface FacebookPage {
    id: string;
    name: string;
    access_token: string;
    instagram_business_id?: string | null;
}

/** Wrap a Graph API error into an actionable message (relays Meta's code). */
const graphError = (error: any, fallback: string): Error => {
    const apiErr = error?.response?.data?.error;
    console.error('[facebook] Graph API error:', error?.response?.data || error?.message);
    if (apiErr) {
        const code = apiErr.code;
        const detail = `${apiErr.message || 'Unknown error'}${code != null ? ` (code ${code}${apiErr.error_subcode ? `/${apiErr.error_subcode}` : ''})` : ''}`;
        if (apiErr.type === 'OAuthException' || code === 190 || code === 200 || code === 10 || code === 100) {
            return new Error(`Facebook authorization failed: ${detail}. Reconnect your Page in the Marketing suite (the token may be expired or missing a permission).`);
        }
        return new Error(`${fallback}: ${detail}`);
    }
    return new Error(`${fallback}: ${error?.message || 'network error'}`);
};

export class FacebookService {
    private encrypt(v: string): string { return CryptoJS.AES.encrypt(v, ENCRYPTION_KEY).toString(); }
    private decrypt(v: string | null): string {
        if (!v) return '';
        try { return CryptoJS.AES.decrypt(v, ENCRYPTION_KEY).toString(CryptoJS.enc.Utf8); }
        catch { return ''; }
    }

    /** appsecret_proof hardens server-side calls (required when "Require App Secret" is on). */
    private proof(token: string): string | undefined {
        if (!FACEBOOK_APP_SECRET) return undefined;
        return crypto.createHmac('sha256', FACEBOOK_APP_SECRET).update(token).digest('hex');
    }

    private params(token: string, extra: Record<string, any> = {}): Record<string, any> {
        const p: Record<string, any> = { access_token: token, ...extra };
        const proof = this.proof(token);
        if (proof) p.appsecret_proof = proof;
        return p;
    }

    // --- Configuration ---

    async getStoreConfig(storeId: string): Promise<FacebookConfig | null> {
        const result = await db.query('SELECT * FROM facebook_config WHERE store_id = $1', [storeId]);
        if (result.rows.length === 0) return null;
        const row = result.rows[0];
        row.page_access_token = this.decrypt(row.page_access_token);
        row.user_access_token = this.decrypt(row.user_access_token);
        return row;
    }

    async saveConnection(storeId: string, data: {
        pageId: string; pageName: string; pageAccessToken: string;
        userAccessToken?: string; instagramBusinessId?: string | null;
    }): Promise<void> {
        await db.query(
            `INSERT INTO facebook_config (store_id, page_id, page_name, page_access_token, user_access_token, instagram_business_id, is_enabled, connected_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW(), NOW())
             ON CONFLICT (store_id) DO UPDATE SET
                page_id = EXCLUDED.page_id,
                page_name = EXCLUDED.page_name,
                page_access_token = EXCLUDED.page_access_token,
                user_access_token = COALESCE(EXCLUDED.user_access_token, facebook_config.user_access_token),
                instagram_business_id = EXCLUDED.instagram_business_id,
                is_enabled = TRUE,
                connected_at = NOW(),
                updated_at = NOW()`,
            [
                storeId, data.pageId, data.pageName,
                this.encrypt(data.pageAccessToken),
                data.userAccessToken ? this.encrypt(data.userAccessToken) : null,
                data.instagramBusinessId || null,
            ],
        );
    }

    /** Persist just the (long-lived) user token so the user can pick a Page next. */
    async saveUserToken(storeId: string, userToken: string): Promise<void> {
        await db.query(
            `INSERT INTO facebook_config (store_id, user_access_token, is_enabled, updated_at)
             VALUES ($1, $2, TRUE, NOW())
             ON CONFLICT (store_id) DO UPDATE SET user_access_token = EXCLUDED.user_access_token, updated_at = NOW()`,
            [storeId, this.encrypt(userToken)],
        );
    }

    async setEnabled(storeId: string, enabled: boolean): Promise<void> {
        await db.query('UPDATE facebook_config SET is_enabled = $1, updated_at = NOW() WHERE store_id = $2', [enabled, storeId]);
    }

    async disconnect(storeId: string): Promise<void> {
        await db.query('DELETE FROM facebook_config WHERE store_id = $1', [storeId]);
    }

    // --- OAuth ---

    /** Exchange a short-lived user token (from the JS SDK) for a long-lived one. */
    async exchangeForLongLivedToken(shortLivedToken: string): Promise<string> {
        try {
            const resp = await axios.get(`${GRAPH}/oauth/access_token`, {
                params: {
                    grant_type: 'fb_exchange_token',
                    client_id: FACEBOOK_APP_ID,
                    client_secret: FACEBOOK_APP_SECRET,
                    fb_exchange_token: shortLivedToken,
                },
            });
            return resp.data.access_token as string;
        } catch (error) {
            throw graphError(error, 'Could not exchange the Facebook token');
        }
    }

    /** List the Pages the user manages, with their (long-lived) Page tokens. */
    async getUserPages(userToken: string): Promise<FacebookPage[]> {
        try {
            const resp = await axios.get(`${GRAPH}/me/accounts`, {
                params: this.params(userToken, { fields: 'id,name,access_token,instagram_business_account' }),
            });
            return (resp.data.data || []).map((p: any): FacebookPage => ({
                id: p.id,
                name: p.name,
                access_token: p.access_token,
                instagram_business_id: p.instagram_business_account?.id || null,
            }));
        } catch (error) {
            throw graphError(error, 'Could not load your Facebook Pages');
        }
    }

    // --- Page operations (use the stored Page token) ---

    private async pageToken(storeId: string): Promise<{ pageId: string; token: string }> {
        const config = await this.getStoreConfig(storeId);
        if (!config || !config.is_enabled || !config.page_id || !config.page_access_token) {
            throw new Error('No Facebook Page is connected for this store.');
        }
        return { pageId: config.page_id, token: config.page_access_token };
    }

    async publishPost(storeId: string, opts: { message?: string; link?: string; imageUrl?: string }): Promise<any> {
        const { pageId, token } = await this.pageToken(storeId);
        try {
            if (opts.imageUrl) {
                const resp = await axios.post(`${GRAPH}/${pageId}/photos`, null, {
                    params: this.params(token, { url: opts.imageUrl, caption: opts.message || '' }),
                });
                return resp.data;
            }
            const body: Record<string, any> = { message: opts.message || '' };
            if (opts.link) body.link = opts.link;
            const resp = await axios.post(`${GRAPH}/${pageId}/feed`, null, { params: this.params(token, body) });
            return resp.data;
        } catch (error) {
            throw graphError(error, 'Could not publish the post');
        }
    }

    async getPosts(storeId: string, limit = 20): Promise<any[]> {
        const { pageId, token } = await this.pageToken(storeId);
        try {
            const resp = await axios.get(`${GRAPH}/${pageId}/feed`, {
                params: this.params(token, {
                    fields: 'id,message,story,created_time,full_picture,permalink_url,comments.summary(true).limit(0),likes.summary(true).limit(0),shares',
                    limit,
                }),
            });
            return resp.data.data || [];
        } catch (error) {
            throw graphError(error, 'Could not load your posts');
        }
    }

    async getComments(storeId: string, postId: string, limit = 50): Promise<any[]> {
        const { token } = await this.pageToken(storeId);
        try {
            const resp = await axios.get(`${GRAPH}/${postId}/comments`, {
                params: this.params(token, { fields: 'id,message,from,created_time,like_count,is_hidden', order: 'reverse_chronological', limit }),
            });
            return resp.data.data || [];
        } catch (error) {
            throw graphError(error, 'Could not load comments');
        }
    }

    async replyToComment(storeId: string, commentId: string, message: string): Promise<any> {
        const { token } = await this.pageToken(storeId);
        try {
            const resp = await axios.post(`${GRAPH}/${commentId}/comments`, null, { params: this.params(token, { message }) });
            return resp.data;
        } catch (error) {
            throw graphError(error, 'Could not reply to the comment');
        }
    }

    async setCommentHidden(storeId: string, commentId: string, hidden: boolean): Promise<any> {
        const { token } = await this.pageToken(storeId);
        try {
            const resp = await axios.post(`${GRAPH}/${commentId}`, null, { params: this.params(token, { is_hidden: hidden }) });
            return resp.data;
        } catch (error) {
            throw graphError(error, 'Could not update the comment');
        }
    }

    async deleteComment(storeId: string, commentId: string): Promise<any> {
        const { token } = await this.pageToken(storeId);
        try {
            const resp = await axios.delete(`${GRAPH}/${commentId}`, { params: this.params(token) });
            return resp.data;
        } catch (error) {
            throw graphError(error, 'Could not delete the comment');
        }
    }

    async getInsights(storeId: string): Promise<any> {
        const { pageId, token } = await this.pageToken(storeId);
        const metrics = ['page_impressions', 'page_post_engagements', 'page_fans', 'page_views_total'];
        try {
            const resp = await axios.get(`${GRAPH}/${pageId}/insights`, {
                params: this.params(token, { metric: metrics.join(','), period: 'days_28' }),
            });
            return resp.data.data || [];
        } catch (error) {
            // Insights can 400 on brand-new Pages with no data — return empty rather than failing the screen.
            console.warn('[facebook] insights unavailable:', (error as any)?.response?.data?.error?.message || (error as any)?.message);
            return [];
        }
    }
}

export default new FacebookService();
