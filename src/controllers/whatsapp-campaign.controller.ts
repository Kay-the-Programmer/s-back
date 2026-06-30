import express from 'express';
import { MODULES, isModuleEnabled } from '../services/entitlements.service';
import { auditService } from '../services/audit.service';
import {
    listCampaigns, createCampaign, updateCampaignStatus, deleteCampaign, runCampaignNow,
} from '../services/whatsapp-campaign.service';

const WHATSAPP_FREE = process.env.WHATSAPP_FREE !== 'false';

const ensureEntitled = async (req: express.Request, res: express.Response): Promise<string | null> => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) { res.status(400).json({ message: 'No store selected.' }); return null; }
    const entitled = WHATSAPP_FREE || await isModuleEnabled(storeId, MODULES.WHATSAPP_MESSAGING);
    if (!entitled) {
        res.status(402).json({ message: 'WhatsApp messaging is a premium feature.', code: 'MODULE_LOCKED', module: MODULES.WHATSAPP_MESSAGING });
        return null;
    }
    return storeId;
};

export const getCampaigns = async (req: express.Request, res: express.Response) => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'No store selected.' });
    try {
        res.json(await listCampaigns(storeId));
    } catch (e: any) {
        console.warn('[wa-campaign] list failed:', e.message);
        res.json([]);
    }
};

export const postCampaign = async (req: express.Request, res: express.Response) => {
    const storeId = await ensureEntitled(req, res);
    if (!storeId) return;
    const b = req.body || {};
    if (!b.name?.trim()) return res.status(400).json({ message: 'A campaign name is required.' });
    if (b.messageMode === 'template') {
        if (!b.templateName?.trim()) return res.status(400).json({ message: 'An approved template name is required for template campaigns.' });
    } else if (!b.messageText?.trim()) {
        return res.status(400).json({ message: 'A message is required.' });
    }
    try {
        const campaign = await createCampaign(storeId, req.user?.id, b);
        if (req.user) auditService.log(req.user, 'WhatsApp Campaign Created', `${campaign.type} · ${campaign.name}`).catch(() => { });
        res.status(201).json(campaign);
    } catch (e: any) {
        res.status(500).json({ message: e.message || 'Failed to create campaign.' });
    }
};

export const patchCampaignStatus = async (req: express.Request, res: express.Response) => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'No store selected.' });
    try {
        const updated = await updateCampaignStatus(storeId, req.params.id, req.body?.status);
        if (!updated) return res.status(400).json({ message: 'Invalid status or campaign not found.' });
        res.json(updated);
    } catch (e: any) {
        res.status(500).json({ message: e.message || 'Failed to update campaign.' });
    }
};

export const removeCampaign = async (req: express.Request, res: express.Response) => {
    const storeId = req.user?.currentStoreId;
    if (!storeId) return res.status(400).json({ message: 'No store selected.' });
    try {
        const ok = await deleteCampaign(storeId, req.params.id);
        if (!ok) return res.status(404).json({ message: 'Campaign not found.' });
        res.json({ success: true });
    } catch (e: any) {
        res.status(500).json({ message: e.message || 'Failed to delete campaign.' });
    }
};

export const runCampaign = async (req: express.Request, res: express.Response) => {
    const storeId = await ensureEntitled(req, res);
    if (!storeId) return;
    try {
        const result = await runCampaignNow(storeId, req.params.id);
        if (req.user) auditService.log(req.user, 'WhatsApp Campaign Sent', `${result.sent} sent`).catch(() => { });
        res.json({ success: true, ...result });
    } catch (e: any) {
        res.status(502).json({ success: false, message: e.message || 'Failed to run campaign.' });
    }
};
