import express from 'express';
import bcrypt from 'bcryptjs';
import db from '../db_client';
import { toCamelCase } from '../utils/helpers';
import { generateToken } from './auth.controller';
import { setSessionCookies } from '../auth/session-cookie';
import { invalidateUserCache } from '../middleware/auth.middleware';
import { auditService } from '../services/audit.service';

/**
 * Switching cashier on a shared till with a short PIN.
 *
 * Each staff member sets their own 4–6 digit till PIN. Whoever is signed in on
 * the till can hand it over by typing the next person's PIN; the session then
 * belongs to that person, so every sale is stamped with who really made it.
 * A PIN only works for staff of the shop the till is signed in to, and
 * guessing is limited to 5 wrong tries per 5 minutes per till.
 */

const PIN_RE = /^\d{4,6}$/;
const STAFF_ROLES = ['admin', 'owner', 'manager', 'staff', 'cashier', 'inventory_manager', 'accountant'];

const storeOf = (req: express.Request): string | undefined =>
    (req as any).tenant?.storeId || req.user?.currentStoreId;

const staffOf = async (storeId: string) => (await db.query(
    `SELECT u.*, s.status AS store_status, s.subscription_status, s.subscription_ends_at, s.subscription_plan
       FROM users u LEFT JOIN stores s ON s.id = u.current_store_id
      WHERE u.current_store_id = $1 AND u.till_pin_hash IS NOT NULL AND u.role <> ALL($2)`,
    [storeId, ['customer', 'supplier', 'superadmin']],
)).rows;

/** PUT /auth/till-pin { pin } — set (or with pin null, clear) my own till PIN. */
export const setTillPin = async (req: express.Request, res: express.Response) => {
    const userId = req.user?.id;
    const storeId = storeOf(req);
    if (!userId || !storeId) return res.status(400).json({ message: 'No shop is selected.' });
    const pin = req.body?.pin;
    if (pin === null) {
        await db.query('UPDATE users SET till_pin_hash = NULL WHERE id = $1', [userId]);
        invalidateUserCache(userId);
        return res.json({ hasTillPin: false });
    }
    if (typeof pin !== 'string' || !PIN_RE.test(pin)) {
        return res.status(400).json({ message: 'Use 4 to 6 digits.' });
    }
    // Two people with one PIN would make the switch ambiguous.
    for (const row of await staffOf(storeId)) {
        if (row.id !== userId && bcrypt.compareSync(pin, row.till_pin_hash)) {
            return res.status(409).json({ message: 'Someone in this shop already uses that PIN. Pick another.' });
        }
    }
    await db.query('UPDATE users SET till_pin_hash = $1 WHERE id = $2', [bcrypt.hashSync(pin, 10), userId]);
    invalidateUserCache(userId);
    return res.json({ hasTillPin: true });
};

/** GET /auth/till-pin — does the signed-in user have a till PIN? */
export const getTillPin = async (req: express.Request, res: express.Response) => {
    const r = await db.query('SELECT till_pin_hash IS NOT NULL AS has FROM users WHERE id = $1', [req.user?.id]);
    res.json({ hasTillPin: !!r.rows[0]?.has });
};

// Wrong-PIN tries per till session (user) and per address.
const tries = new Map<string, { n: number; until: number }>();
const WINDOW = 5 * 60 * 1000;
const MAX_TRIES = 5;
const blocked = (k: string) => { const t = tries.get(k); return !!t && t.until > Date.now() && t.n >= MAX_TRIES; };
const miss = (k: string) => {
    const t = tries.get(k);
    if (!t || t.until < Date.now()) tries.set(k, { n: 1, until: Date.now() + WINDOW });
    else t.n += 1;
};

/** POST /auth/till-switch { pin } — hand this till to the staff member with that PIN. */
export const switchCashier = async (req: express.Request, res: express.Response) => {
    const storeId = storeOf(req);
    if (!storeId || !req.user?.id) return res.status(400).json({ message: 'No shop is selected.' });
    const keys = [`u:${req.user.id}`, `ip:${req.ip}`];
    if (keys.some(blocked)) {
        return res.status(429).json({ message: 'Too many wrong PINs. Wait 5 minutes, or sign in with email and password.' });
    }
    const pin = String(req.body?.pin ?? '');
    if (!PIN_RE.test(pin)) return res.status(400).json({ message: 'Enter a 4 to 6 digit PIN.' });

    let match: any = null;
    for (const row of await staffOf(storeId)) {
        // Compare every candidate so timing doesn't reveal the staff count.
        if (bcrypt.compareSync(pin, row.till_pin_hash) && !match) match = row;
    }
    if (!match || !STAFF_ROLES.includes(String(match.role))) {
        keys.forEach(miss);
        return res.status(401).json({ message: 'That PIN doesn’t match anyone in this shop.' });
    }
    keys.forEach(k => tries.delete(k));

    const token = generateToken(match.id, match.token_version);
    setSessionCookies(res, token);
    auditService.log(req.user as any, 'Till handed over', `${req.user.name || req.user.id} → ${match.name}`);
    return res.json(toCamelCase({
        id: match.id, name: match.name, email: match.email, role: match.role, phone: match.phone,
        profile_picture: match.profile_picture, current_store_id: match.current_store_id, is_verified: match.is_verified,
        store_status: match.store_status, subscription_status: match.subscription_status,
        subscription_ends_at: match.subscription_ends_at, subscription_plan: match.subscription_plan,
        token,
    }));
};
