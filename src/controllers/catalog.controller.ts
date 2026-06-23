import express from 'express';
import { auditService } from '../services/audit.service';
import {
    getModules, getPlans, upsertModule, deleteModule, upsertPlan, deletePlan,
    CatalogModule, CatalogPlan,
} from '../services/catalog.service';

/**
 * Super Admin commerce catalog management — configure add-on module prices, the
 * pages each unlocks, which modules can be bought independently, and the
 * subscription plans (price, included modules, AI limit, etc.).
 */

const num = (v: any, fallback = 0) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : fallback;
};
const strArr = (v: any): string[] =>
    Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim()) : [];

// --- Modules -----------------------------------------------------------------

export const listCatalogModules = async (_req: express.Request, res: express.Response) => {
    try {
        return res.status(200).json({ modules: await getModules(true) });
    } catch (e: any) {
        console.error('Error listing catalog modules', e);
        return res.status(500).json({ message: 'Failed to load modules.' });
    }
};

export const saveCatalogModule = async (req: express.Request, res: express.Response) => {
    try {
        const b = req.body || {};
        if (!b.name || !String(b.name).trim()) {
            return res.status(400).json({ message: 'Module name is required.' });
        }
        const input: Partial<CatalogModule> & { name: string } = {
            id: req.params.id || b.id,
            name: String(b.name).trim(),
            description: b.description != null ? String(b.description) : undefined,
            price: b.price != null ? num(b.price) : undefined,
            currency: b.currency,
            pages: b.pages != null ? strArr(b.pages) : undefined,
            independentlyPurchasable: b.independentlyPurchasable != null ? !!b.independentlyPurchasable : undefined,
            isCore: b.isCore != null ? !!b.isCore : undefined,
            active: b.active != null ? !!b.active : undefined,
            sortOrder: b.sortOrder != null ? num(b.sortOrder) : undefined,
        };
        const saved = await upsertModule(input);
        await auditService.log(req.user!, 'Catalog Module Saved', `${saved.id}: ${saved.name} @ ${saved.currency} ${saved.price}`);
        return res.status(200).json({ module: saved });
    } catch (e: any) {
        console.error('Error saving catalog module', e);
        return res.status(500).json({ message: 'Failed to save module.' });
    }
};

export const removeCatalogModule = async (req: express.Request, res: express.Response) => {
    try {
        await deleteModule(req.params.id);
        await auditService.log(req.user!, 'Catalog Module Deleted', req.params.id);
        return res.status(200).json({ ok: true });
    } catch (e: any) {
        console.error('Error deleting catalog module', e);
        return res.status(500).json({ message: 'Failed to delete module.' });
    }
};

// --- Plans -------------------------------------------------------------------

export const listCatalogPlans = async (_req: express.Request, res: express.Response) => {
    try {
        return res.status(200).json({ plans: await getPlans(true) });
    } catch (e: any) {
        console.error('Error listing catalog plans', e);
        return res.status(500).json({ message: 'Failed to load plans.' });
    }
};

export const saveCatalogPlan = async (req: express.Request, res: express.Response) => {
    try {
        const b = req.body || {};
        if (!b.name || !String(b.name).trim()) {
            return res.status(400).json({ message: 'Plan name is required.' });
        }
        const input: Partial<CatalogPlan> & { name: string } = {
            id: req.params.id || b.id,
            name: String(b.name).trim(),
            description: b.description != null ? String(b.description) : undefined,
            price: b.price != null ? num(b.price) : undefined,
            currency: b.currency,
            interval: b.interval === 'year' ? 'year' : (b.interval === 'month' ? 'month' : undefined),
            moduleIds: b.moduleIds != null ? strArr(b.moduleIds) : undefined,
            features: b.features != null ? strArr(b.features) : undefined,
            aiRequestsLimit: b.aiRequestsLimit != null ? Math.trunc(num(b.aiRequestsLimit)) : undefined,
            isPopular: b.isPopular != null ? !!b.isPopular : undefined,
            active: b.active != null ? !!b.active : undefined,
            sortOrder: b.sortOrder != null ? num(b.sortOrder) : undefined,
        };
        const saved = await upsertPlan(input);
        await auditService.log(req.user!, 'Catalog Plan Saved', `${saved.id}: ${saved.name} @ ${saved.currency} ${saved.price}`);
        return res.status(200).json({ plan: saved });
    } catch (e: any) {
        console.error('Error saving catalog plan', e);
        return res.status(500).json({ message: 'Failed to save plan.' });
    }
};

export const removeCatalogPlan = async (req: express.Request, res: express.Response) => {
    try {
        await deletePlan(req.params.id);
        await auditService.log(req.user!, 'Catalog Plan Deleted', req.params.id);
        return res.status(200).json({ ok: true });
    } catch (e: any) {
        console.error('Error deleting catalog plan', e);
        return res.status(500).json({ message: 'Failed to delete plan.' });
    }
};
