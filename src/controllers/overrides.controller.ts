import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../db_client';
import { auditService } from '../services/audit.service';
import { roleHasPermission, Role } from '../auth/rbac';
import { isOverrideAction, isValidPin, MIN_PIN_LENGTH } from '../services/override-rules';
import { grantOverride, loadThresholds, managerForPin } from '../services/override.service';

/**
 * A manager standing at the till, allowing one thing.
 *
 * The cashier never gains the permission — they gain a single code, for one
 * action, at one size, for a few minutes. Everything about who allowed what
 * lands in the audit log, which is the point: a shop that solves this by
 * sharing the manager login has no record at all.
 */

const storeOf = (req: express.Request): string | undefined =>
    (req as any).tenant?.storeId;

const parseAmount = (raw: unknown): number | null => {
    const n = typeof raw === 'number' ? raw : parseFloat(String(raw ?? ''));
    if (!Number.isFinite(n) || n < 0 || n > 100000000) return null;
    return Math.round((n + Number.EPSILON) * 100) / 100;
};

/** Ask a manager to allow something. */
export const authorizeOverride = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });

        const action = req.body?.action;
        if (!isOverrideAction(action)) {
            return res.status(400).json({ message: 'Say what is being approved.' });
        }

        // Bound into the authorisation: approving a 20% discount is not
        // approving a 90% one, and the ceiling is rechecked when it is spent.
        const maxAmount = req.body?.amount === undefined || req.body?.amount === null
            ? null
            : parseAmount(req.body.amount);
        if (req.body?.amount !== undefined && req.body?.amount !== null && maxAmount === null) {
            return res.status(400).json({ message: 'That amount is not a number.' });
        }

        const pin = String(req.body?.pin ?? '');
        if (!pin) return res.status(400).json({ message: 'Enter the manager PIN.' });

        const manager = await managerForPin(storeId, pin);
        if (!manager) {
            // Recorded even on failure: repeated refusals at one till are worth
            // seeing, and they are invisible if only successes are logged.
            await auditService.log(
                req.user!,
                'Override Refused',
                `${action} — PIN not recognised${maxAmount === null ? '' : ` (amount ${maxAmount})`}`,
            ).catch(() => {});
            return res.status(403).json({ message: 'That PIN was not recognised.' });
        }

        const granted = await grantOverride({
            storeId,
            action,
            maxAmount,
            authorizedBy: manager,
            requestedBy: { id: req.user?.id, name: req.user?.name },
            reason: req.body?.reason,
        });

        await auditService.log(
            req.user!,
            'Override Approved',
            `${action}${maxAmount === null ? '' : ` up to ${maxAmount}`} approved by ${manager.name}` +
                ` for ${req.user?.name || 'unknown'}`,
        );

        return res.status(201).json(granted);
    } catch (e: any) {
        console.error('authorizeOverride failed:', e?.message);
        return res.status(500).json({ message: 'Could not check that PIN.' });
    }
};

/**
 * Set or clear your own manager PIN.
 *
 * Guarded by the account password, so someone who walks up to an unlocked
 * session cannot quietly give themselves a code that approves their own
 * discounts.
 */
export const setManagerPin = async (req: express.Request, res: express.Response) => {
    try {
        if (!roleHasPermission(req.user?.role as Role, 'override:authorize')) {
            return res.status(403).json({ message: 'Only a manager can hold an approval PIN.' });
        }

        const password = String(req.body?.password ?? '');
        if (!password) return res.status(400).json({ message: 'Confirm your password.' });

        const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user?.id]);
        if (!rows.length || !bcrypt.compareSync(password, rows[0].password_hash)) {
            return res.status(403).json({ message: 'That password is not right.' });
        }

        const pin = req.body?.pin;
        if (pin === null || pin === '') {
            await db.query('UPDATE users SET manager_pin_hash = NULL WHERE id = $1', [req.user?.id]);
            await auditService.log(req.user!, 'Manager PIN Cleared', 'Approval PIN removed.');
            return res.json({ hasPin: false });
        }

        if (!isValidPin(pin)) {
            return res.status(400).json({
                message: `A PIN must be ${MIN_PIN_LENGTH} to 12 digits, numbers only.`,
            });
        }
        // Rejected outright rather than merely discouraged: a PIN is compared
        // against every manager in the store, so an obvious one is everyone's
        // problem, not just its owner's.
        if (/^(\d)\1+$/.test(pin) || '0123456789012'.includes(pin) || '9876543210987'.includes(pin)) {
            return res.status(400).json({ message: 'Choose a PIN that is not a run or a repeat.' });
        }

        await db.query(
            'UPDATE users SET manager_pin_hash = $1 WHERE id = $2',
            [bcrypt.hashSync(pin, 10), req.user?.id],
        );
        await auditService.log(req.user!, 'Manager PIN Set', 'Approval PIN was set or changed.');
        return res.json({ hasPin: true });
    } catch (e: any) {
        console.error('setManagerPin failed:', e?.message);
        return res.status(500).json({ message: 'Could not save that PIN.' });
    }
};

/** What this till must ask a manager about, so the UI knows before it asks. */
export const getOverrideThresholds = async (req: express.Request, res: express.Response) => {
    try {
        const storeId = storeOf(req);
        if (!storeId) return res.status(400).json({ message: 'No active store selected.' });
        const thresholds = await loadThresholds(storeId);
        return res.json({
            ...thresholds,
            // A manager working the till approves nothing — they simply act.
            selfAuthorizes: roleHasPermission(req.user?.role as Role, 'override:authorize'),
        });
    } catch (e: any) {
        console.error('getOverrideThresholds failed:', e?.message);
        return res.status(500).json({ message: 'Could not load approval settings.' });
    }
};
