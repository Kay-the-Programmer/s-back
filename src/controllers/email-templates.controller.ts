import express from 'express';
import { auditService } from '../services/audit.service';
import { sendEmail } from '../services/email.service';
import {
    listEmailTemplates,
    createCustomTip,
    updateEmailTemplate,
    deleteEmailTemplate,
    resetEmailTemplate,
    previewTemplate,
    isBuiltIn,
} from '../services/email-template.service';

/**
 * Super Admin management of the automated email engine: list templates, build
 * custom tips from scratch, edit subject/HTML/name/enabled/conditions/schedule,
 * live-preview with sample data, send a test, reset built-ins, delete custom tips.
 */

export const listEmailTemplatesHandler = async (_req: express.Request, res: express.Response) => {
    try {
        return res.status(200).json({ templates: await listEmailTemplates() });
    } catch (e: any) {
        console.error('Error listing email templates', e);
        return res.status(500).json({ message: 'Failed to load email templates.' });
    }
};

/** Create a new custom onboarding tip (starts disabled so drafts don't send). */
export const createEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const b = req.body || {};
        const row = await createCustomTip({
            name: typeof b.name === 'string' ? b.name : undefined,
            subject: typeof b.subject === 'string' ? b.subject : undefined,
            html: typeof b.html === 'string' ? b.html : undefined,
            sendDay: b.sendDay,
            enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
        }, req.user?.id);
        await auditService.log(req.user!, 'Email Template Created', `Custom tip: ${row?.key}`);
        return res.status(201).json({ template: row });
    } catch (e: any) {
        console.error('Error creating email template', e);
        return res.status(500).json({ message: e?.message || 'Failed to create tip.' });
    }
};

export const updateEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const { key } = req.params;
        const b = req.body || {};
        const patch: { name?: string; subject?: string; html?: string; enabled?: boolean; config?: Record<string, any> } = {};
        if (typeof b.name === 'string') patch.name = b.name;
        if (typeof b.subject === 'string') patch.subject = b.subject;
        if (typeof b.html === 'string') patch.html = b.html;
        if (typeof b.enabled === 'boolean') patch.enabled = b.enabled;
        if (b.config && typeof b.config === 'object') patch.config = b.config;

        if (patch.subject !== undefined && !patch.subject.trim()) {
            return res.status(400).json({ message: 'Subject cannot be empty.' });
        }
        if (patch.html !== undefined && !patch.html.trim()) {
            return res.status(400).json({ message: 'Email body cannot be empty.' });
        }

        const row = await updateEmailTemplate(key, patch, req.user?.id);
        await auditService.log(req.user!, 'Email Template Updated', `Template: ${key}`);
        return res.status(200).json({ template: row });
    } catch (e: any) {
        console.error('Error updating email template', e);
        const notFound = /Unknown email template/.test(e?.message || '');
        return res.status(notFound ? 404 : 500).json({ message: e?.message || 'Failed to update email template.' });
    }
};

/** Delete a custom tip (built-ins are protected). */
export const deleteEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const { key } = req.params;
        await deleteEmailTemplate(key);
        await auditService.log(req.user!, 'Email Template Deleted', `Template: ${key}`);
        return res.status(200).json({ message: 'Tip deleted.' });
    } catch (e: any) {
        console.error('Error deleting email template', e);
        const code = /cannot be deleted/.test(e?.message || '') ? 400 : /Unknown/.test(e?.message || '') ? 404 : 500;
        return res.status(code).json({ message: e?.message || 'Failed to delete tip.' });
    }
};

/** Restore a built-in template's subject + HTML to the on-brand default. */
export const resetEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const { key } = req.params;
        if (!isBuiltIn(key)) return res.status(400).json({ message: 'Custom tips have no default to reset to.' });
        const row = await resetEmailTemplate(key, req.user?.id);
        await auditService.log(req.user!, 'Email Template Reset', `Template: ${key}`);
        return res.status(200).json({ template: row });
    } catch (e: any) {
        console.error('Error resetting email template', e);
        return res.status(500).json({ message: e?.message || 'Failed to reset email template.' });
    }
};

/** Render subject + HTML with the template's sample data (for the live preview). */
export const previewEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const { key } = req.params;
        const b = req.body || {};
        // Preview honours unsaved edits sent from the editor; falls back to the stored template.
        const rendered = await previewTemplate(key, {
            subject: typeof b.subject === 'string' ? b.subject : undefined,
            html: typeof b.html === 'string' ? b.html : undefined,
        });
        if (!rendered) return res.status(404).json({ message: 'Unknown email template.' });
        return res.status(200).json(rendered);
    } catch (e: any) {
        console.error('Error previewing email template', e);
        return res.status(500).json({ message: 'Failed to render preview.' });
    }
};

/** Send a test email (with sample data) to the signed-in superadmin. */
export const testEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const { key } = req.params;
        const to = (req.body?.to && String(req.body.to).trim()) || req.user?.email;
        if (!to) return res.status(400).json({ message: 'No recipient email available for the test.' });

        // A test always sends, regardless of the template's enabled flag / conditions.
        const rendered = await previewTemplate(key, {
            subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
            html: typeof req.body?.html === 'string' ? req.body.html : undefined,
        });
        if (!rendered) return res.status(404).json({ message: 'Unknown email template.' });
        await sendEmail(to, `[TEST] ${rendered.subject}`, rendered.html);
        await auditService.log(req.user!, 'Email Template Test Sent', `Template: ${key} → ${to}`);
        return res.status(200).json({ message: `Test email sent to ${to}.` });
    } catch (e: any) {
        console.error('Error sending test email', e);
        return res.status(500).json({ message: e?.message || 'Failed to send test email.' });
    }
};
