import express from 'express';
import { auditService } from '../services/audit.service';
import { sendEmail } from '../services/email.service';
import {
    listEmailTemplates,
    updateEmailTemplate,
    resetEmailTemplate,
    renderEmailTemplate,
    EMAIL_TEMPLATES,
} from '../services/email-template.service';

/**
 * Super Admin management of the automated email engine: list templates, edit
 * subject/HTML/enabled/conditions, live-preview with sample data, and send a
 * test to the signed-in superadmin.
 */

const DEF_BY_KEY = new Map(EMAIL_TEMPLATES.map(t => [t.key, t]));

export const listEmailTemplatesHandler = async (_req: express.Request, res: express.Response) => {
    try {
        return res.status(200).json({ templates: await listEmailTemplates() });
    } catch (e: any) {
        console.error('Error listing email templates', e);
        return res.status(500).json({ message: 'Failed to load email templates.' });
    }
};

export const updateEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const { key } = req.params;
        if (!DEF_BY_KEY.has(key)) return res.status(404).json({ message: 'Unknown email template.' });

        const b = req.body || {};
        const patch: { subject?: string; html?: string; enabled?: boolean; config?: Record<string, any> } = {};
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
        return res.status(500).json({ message: e?.message || 'Failed to update email template.' });
    }
};

/** Restore a template's subject + HTML to the on-brand default. */
export const resetEmailTemplateHandler = async (req: express.Request, res: express.Response) => {
    try {
        const { key } = req.params;
        if (!DEF_BY_KEY.has(key)) return res.status(404).json({ message: 'Unknown email template.' });
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
        const def = DEF_BY_KEY.get(key);
        if (!def) return res.status(404).json({ message: 'Unknown email template.' });

        const b = req.body || {};
        // Preview honours unsaved edits sent from the editor.
        const rendered = renderEmailTemplate(key, def.sample, {
            subject: typeof b.subject === 'string' ? b.subject : undefined,
            html: typeof b.html === 'string' ? b.html : undefined,
        });
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
        const def = DEF_BY_KEY.get(key);
        if (!def) return res.status(404).json({ message: 'Unknown email template.' });

        const to = (req.body?.to && String(req.body.to).trim()) || req.user?.email;
        if (!to) return res.status(400).json({ message: 'No recipient email available for the test.' });

        // A test always sends, regardless of the template's enabled flag / conditions.
        const rendered = renderEmailTemplate(key, def.sample, {
            subject: typeof req.body?.subject === 'string' ? req.body.subject : undefined,
            html: typeof req.body?.html === 'string' ? req.body.html : undefined,
        });
        await sendEmail(to, `[TEST] ${rendered.subject}`, rendered.html);
        await auditService.log(req.user!, 'Email Template Test Sent', `Template: ${key} → ${to}`);
        return res.status(200).json({ message: `Test email sent to ${to}.` });
    } catch (e: any) {
        console.error('Error sending test email', e);
        return res.status(500).json({ message: e?.message || 'Failed to send test email.' });
    }
};
