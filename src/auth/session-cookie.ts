import crypto from 'crypto';
import express from 'express';

/**
 * Session cookies.
 *
 * The web app used to keep its JWT in localStorage, where any successful XSS
 * reads it and walks away with a 30-day credential. Moving it into an
 * httpOnly cookie puts it out of JavaScript's reach entirely.
 *
 * Bearer tokens still work and must keep working: the Flutter desktop till,
 * the mobile apps and the test suites all send an Authorization header, and
 * none of them is exposed to browser XSS in the first place. So the server
 * accepts either, and the header wins when both are present — existing
 * sessions carry on unchanged and nobody is signed out by the deploy.
 *
 * The thing this trades for XSS safety is CSRF exposure. A Bearer header has
 * to be set deliberately by the caller, so another site cannot forge an
 * authenticated request. A cookie rides along on any request the browser
 * makes, including one triggered from an attacker's page. That is what
 * `csrfGuard` below exists to stop, and it is why the guard applies to
 * cookie-authenticated requests only.
 */

export const SESSION_COOKIE = 'sp_session';

/**
 * Readable by JavaScript ON PURPOSE — that is the whole mechanism. The client
 * reads this value and echoes it in a header; an attacker's page can make the
 * browser SEND our cookies but cannot READ them across origins, so it cannot
 * produce the matching header. (Double-submit cookie pattern.)
 */
export const CSRF_COOKIE = 'sp_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const isProduction = process.env.NODE_ENV === 'production';

/**
 * `lax` is right when the app and the API are the same site, which they are on
 * salepilot.space + api.salepilot.space, and it blocks cross-site POSTs by
 * itself. A deployment where the app is served from a genuinely different site
 * (a *.vercel.app preview, say) needs `none`, which switches that protection
 * off and leaves csrfGuard as the only thing standing — and Safari blocks such
 * cookies regardless, so those origins fall back to Bearer.
 */
const sameSite = (process.env.SESSION_COOKIE_SAMESITE || 'lax').toLowerCase() as 'lax' | 'strict' | 'none';

// SameSite=None without Secure is rejected by every current browser, so it is
// forced on rather than silently producing a cookie nothing will store.
const secure = sameSite === 'none' ? true : isProduction;

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // matches the JWT's own 30d expiry

const baseOptions = {
    sameSite,
    secure,
    path: '/',
    maxAge: MAX_AGE_MS,
};

/**
 * Minimal cookie-header parse. `cookie-parser` would do this, but it is one
 * value and adding a dependency means touching the lockfile and the Docker
 * npm layer for no gain.
 */
export const readCookie = (req: express.Request, name: string): string | undefined => {
    const header = req.headers.cookie;
    if (!header) return undefined;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq === -1) continue;
        if (part.slice(0, eq).trim() !== name) continue;
        try {
            return decodeURIComponent(part.slice(eq + 1).trim());
        } catch {
            return part.slice(eq + 1).trim();
        }
    }
    return undefined;
};

/** The bearer token for this request: header first, then the session cookie. */
export const tokenFromRequest = (req: express.Request): string | undefined => {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer')) {
        const fromHeader = authHeader.split(' ')[1];
        if (fromHeader && fromHeader !== 'null' && fromHeader !== 'undefined') return fromHeader;
    }
    return readCookie(req, SESSION_COOKIE);
};

/** True when this request's credential is the cookie rather than a header. */
export const isCookieAuthenticated = (req: express.Request): boolean => {
    const authHeader = req.headers.authorization;
    const headerToken =
        authHeader && authHeader.startsWith('Bearer') ? authHeader.split(' ')[1] : undefined;
    const hasUsableHeader = !!headerToken && headerToken !== 'null' && headerToken !== 'undefined';
    return !hasUsableHeader && !!readCookie(req, SESSION_COOKIE);
};

/** Issue the session cookie and its CSRF partner. Called wherever a token is minted. */
export const setSessionCookies = (res: express.Response, token: string) => {
    res.cookie(SESSION_COOKIE, token, { ...baseOptions, httpOnly: true });
    res.cookie(CSRF_COOKIE, crypto.randomBytes(32).toString('hex'), {
        ...baseOptions,
        httpOnly: false,
    });
};

/**
 * Clear both. maxAge is dropped and the remaining attributes are kept
 * identical, because a browser only replaces a cookie when name, path and
 * domain all match — clear it with different attributes and the old one simply
 * stays put.
 */
export const clearSessionCookies = (res: express.Response) => {
    const { maxAge, ...rest } = baseOptions;
    res.clearCookie(SESSION_COOKIE, { ...rest, httpOnly: true });
    res.clearCookie(CSRF_COOKIE, { ...rest, httpOnly: false });
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Entry points that are exempt, because they are reached by design without a
 * session and must keep working for someone who happens to still hold a stale
 * cookie — otherwise a leftover cookie would block the very act of signing in
 * again, or signing out. None of them performs a privileged action on an
 * existing session, so there is nothing here for another site to forge.
 */
const CSRF_EXEMPT = /^\/api\/auth\/(login|logout|register|register-customer|register-supplier|google|forgot-password|reset-password|verify-email|verify-registration|resend-verification)(\/|\?|$)/;

/**
 * Reject cookie-authenticated writes that do not echo the CSRF cookie.
 *
 * Applies ONLY to requests whose credential is the cookie. A Bearer-header
 * request is already immune — a cross-site page cannot set that header — so
 * requiring a CSRF token there would break every native client and test for
 * no security gain.
 */
export const csrfGuard = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    if (!isCookieAuthenticated(req)) return next();
    if (CSRF_EXEMPT.test((req.originalUrl || req.url || '').toLowerCase())) return next();

    const cookieValue = readCookie(req, CSRF_COOKIE);
    const headerValue = req.get(CSRF_HEADER);

    if (!cookieValue || !headerValue) {
        return res.status(403).json({
            message: 'Missing CSRF token. Refresh the page and try again.',
            code: 'CSRF_TOKEN_MISSING',
        });
    }

    // Constant-time compare. Lengths are checked first because timingSafeEqual
    // throws on a length mismatch rather than returning false.
    const a = Buffer.from(cookieValue);
    const b = Buffer.from(headerValue);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(403).json({
            message: 'CSRF token mismatch. Refresh the page and try again.',
            code: 'CSRF_TOKEN_INVALID',
        });
    }

    next();
};
