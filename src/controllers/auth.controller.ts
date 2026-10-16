import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../db_client';
import { User } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import express from 'express';
import { invalidateUserCache } from '../middleware/auth.middleware';
import { revokeUserSessions } from '../services/session.service';
import { setSessionCookies, clearSessionCookies } from '../auth/session-cookie';
import { signInWithEmailAndPassword, signInWithPhoneNumber } from "firebase/auth";
import { authentication } from "../firebase";

// Use a safe fallback to avoid runtime 500s if JWT_SECRET is missing in env.
// In production, set JWT_SECRET in your hosting provider (Render) dashboard.
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_DEV_ONLY';

/**
 * `tv` is the user's token_version at signing time. `protect` compares it with
 * the column and rejects the token if the column has moved on, which is how a
 * password change, a demotion or a sign-out-everywhere reaches tokens that are
 * already out there (see services/session.service.ts).
 *
 * Callers must pass the CURRENT value. Signing a token right after revoking
 * sessions needs the post-bump number, or the new token is dead on arrival.
 */
const generateToken = (id: string, tokenVersion: number = 0) => {
    return jwt.sign({ id, tv: tokenVersion }, JWT_SECRET, {
        expiresIn: '30d',
    });
};

import crypto from 'crypto';
import { sendVerificationEmail, sendOTPVerificationEmail, sendPasswordResetEmail, sendWelcomeEmail } from '../services/email.service';
import { adminApp } from '../firebase';
import { referralService } from '../services/referral.service';

// Helper to generate random token
const generateRandomToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

/**
 * Six-digit numeric OTP, drawn from the CSPRNG.
 *
 * Math.random() is a non-cryptographic PRNG: V8 seeds one xorshift128+ stream
 * per context, so observing a few outputs is enough to recover its state and
 * predict the rest. Since this OTP is what proves control of an email address,
 * a predictable one let an attacker verify an account whose inbox they do not
 * own. randomInt is rejection-sampled, so the digits stay uniform.
 */
const generateOTP = () => {
    return crypto.randomInt(100000, 1000000).toString();
};

export const loginUser = async (req: express.Request, res: express.Response) => {
    const { email, password } = req.body || {};
    try {
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }
        const normEmail = String(email).toLowerCase();
        const result = await db.query(`
            SELECT u.*, s.status AS store_status, s.subscription_status, s.subscription_ends_at, s.subscription_plan
            FROM users u
            LEFT JOIN stores s ON u.current_store_id = s.id 
            WHERE u.email = $1
        `, [normEmail]);
        const user = result.rows[0];

        if (user && user.password_hash && (await bcrypt.compare(String(password), user.password_hash))) {
            // Hard gate: an unverified account cannot obtain a session. We issue no
            // token and instead re-send a fresh OTP so the user can verify. The
            // seeded superadmin is exempt (see the protect-middleware rationale).
            if (!user.is_verified && user.role !== 'superadmin') {
                let otpSent = false;
                try {
                    const otp = generateOTP();
                    await db.query('UPDATE users SET verification_token = $1 WHERE id = $2', [otp, user.id]);
                    invalidateUserCache(user.id);
                    otpSent = await sendOTPVerificationEmail(user.email, otp);
                } catch (e) {
                    console.error('[login] Failed to resend verification OTP:', e);
                }
                return res.status(403).json({
                    message: otpSent
                        ? 'Please verify your email address before signing in. We just sent a new verification code to your inbox.'
                        : 'Please verify your email address before signing in. We could not send a verification code right now — use "Resend code" in a moment.',
                    code: 'EMAIL_NOT_VERIFIED',
                    requiresVerification: true,
                    emailSent: otpSent,
                    email: user.email,
                });
            }
            const loginToken = generateToken(user.id, user.token_version);
            const userResponse = toCamelCase({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                phone: user.phone,
                profile_picture: user.profile_picture,
                current_store_id: user.current_store_id,
                is_verified: user.is_verified,
                store_status: user.store_status,
                subscription_status: user.subscription_status,
                subscription_ends_at: user.subscription_ends_at,
                subscription_plan: user.subscription_plan,
                // Still in the body: the Flutter till, the mobile apps and the
                // test suites all read it from here, and a browser client is
                // free to ignore it now that the cookie carries the session.
                token: loginToken,
            });
            // The browser gets the same token as an httpOnly cookie, out of
            // reach of any script — which is the point of the exercise.
            setSessionCookies(res, loginToken);
            return res.json(userResponse);
        }
        return res.status(401).json({ message: 'Invalid credentials' });
    } catch (error) {
        console.error('Login error:', error);
        return res.status(500).json({ message: 'Server error during login' });
    }
};

export const registerUser = async (req: express.Request, res: express.Response) => {
    const { name, email, password } = req.body || {};
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Please add all fields' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    try {
        const normEmail = String(email).toLowerCase();
        const userExistsResult = await db.query('SELECT id FROM users WHERE email = $1', [normEmail]);
        if ((userExistsResult.rowCount ?? 0) > 0) {
            return res.status(409).json({ message: 'User already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(String(password), salt);
        const id = generateId('user');
        const role = 'staff'; // Default role

        // Generate verification OTP
        const verificationToken = generateOTP();

        const referralCode = referralService.generateReferralCode();
        const signupReferralCode = req.body.referralCode;

        const insertResult = await db.query(
            'INSERT INTO users(id, name, email, password_hash, role, verification_token, is_verified, referral_code) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, role, phone, is_verified, referral_code',
            [id, String(name), normEmail, password_hash, role, verificationToken, false, referralCode]
        );
        const newUser = insertResult.rows[0];

        // Process referral if provided
        if (signupReferralCode) {
            await referralService.processReferral(newUser.id, signupReferralCode);
        }

        // Send OTP verification email. The account is created either way (the
        // user can "Resend code" later), but the client is told the truth.
        let emailSent = false;
        try {
            emailSent = await sendOTPVerificationEmail(newUser.email, verificationToken);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
        }

        // No session token is issued at registration — the account is unusable
        // until the email is verified (enforced by loginUser + the protect gate).
        // The client must call /auth/verify-registration, then /auth/login.
        const userResponse = toCamelCase({
            ...newUser,
            requiresVerification: true,
            emailSent,
        });

        return res.status(201).json(userResponse);
    } catch (error: any) {
        console.error('Registration error:', error);
        const message = (error?.code === '23505') ? 'User already exists' : 'Server error during registration';
        const status = (error?.code === '23505') ? 409 : 500;
        return res.status(status).json({ message });
    }
};

export const registerCustomer = async (req: express.Request, res: express.Response) => {
    const { name, email, password, phone } = req.body || {};
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Please add all fields' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    try {
        const normEmail = String(email).toLowerCase();
        const userExistsResult = await db.query('SELECT id FROM users WHERE email = $1', [normEmail]);
        if ((userExistsResult.rowCount ?? 0) > 0) {
            return res.status(409).json({ message: 'User already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(String(password), salt);
        const id = generateId('user');
        const role = 'customer'; // Set role to customer

        // Verification logic
        const verificationToken = generateOTP();
        const referralCode = referralService.generateReferralCode();
        const signupReferralCode = req.body.referralCode;

        const insertResult = await db.query(
            'INSERT INTO users(id, name, email, password_hash, role, phone, verification_token, is_verified, referral_code) VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name, email, role, phone, is_verified, referral_code',
            [id, String(name), normEmail, password_hash, role, phone || null, verificationToken, false, referralCode]
        );
        const newUser = insertResult.rows[0];

        // Process referral if provided
        if (signupReferralCode) {
            await referralService.processReferral(newUser.id, signupReferralCode);
        }

        // Send verification email
        let emailSent = false;
        try {
            emailSent = await sendOTPVerificationEmail(newUser.email, verificationToken);
        } catch (e) { console.error('Email send failed', e); }

        // No session token at registration — verify email first, then log in.
        const userResponse = toCamelCase({
            ...newUser,
            requiresVerification: true,
            emailSent,
        });

        return res.status(201).json(userResponse);
    } catch (error: any) {
        console.error('Customer registration error:', error);
        const message = (error?.code === '23505') ? 'User already exists' : 'Server error during registration';
        const status = (error?.code === '23505') ? 409 : 500;
        return res.status(status).json({ message });
    }
};

export const registerSupplier = async (req: express.Request, res: express.Response) => {
    const { name, email, password, phone, companyName, companyAddress } = req.body || {};
    if (!name || !email || !password) {
        return res.status(400).json({ message: 'Please add all required fields' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ message: 'Password must be at least 8 characters long.' });
    }

    try {
        const normEmail = String(email).toLowerCase();
        const userExistsResult = await db.query('SELECT id FROM users WHERE email = $1', [normEmail]);
        if ((userExistsResult.rowCount ?? 0) > 0) {
            return res.status(409).json({ message: 'User already exists' });
        }

        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(String(password), salt);
        const id = generateId('user');
        const role = 'supplier';

        // Verification logic
        const verificationToken = generateOTP();

        const insertResult = await db.query(
            'INSERT INTO users(id, name, email, password_hash, role, phone, verification_token, is_verified) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, role, phone, is_verified',
            [id, String(name), normEmail, password_hash, role, phone || null, verificationToken, false]
        );
        const newUser = insertResult.rows[0];

        let emailSent = false;
        try {
            emailSent = await sendOTPVerificationEmail(newUser.email, verificationToken);
        } catch (e) { console.error('Email send failed', e); }

        // No session token at registration — verify email first, then log in.
        const userResponse = toCamelCase({
            ...newUser,
            requiresVerification: true,
            emailSent,
        });

        return res.status(201).json(userResponse);
    } catch (error: any) {
        console.error('Supplier registration error:', error);
        const message = (error?.code === '23505') ? 'User already exists' : 'Server error during registration';
        const status = (error?.code === '23505') ? 409 : 500;
        return res.status(status).json({ message });
    }
};

export const getCurrentUser = (req: express.Request, res: express.Response) => {
    res.status(200).json(toCamelCase(req.user));
};

export const verifyEmail = async (req: express.Request, res: express.Response) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token is required' });

    try {
        const result = await db.query('SELECT id, email FROM users WHERE verification_token = $1', [token]);
        if (result.rowCount === 0) {
            return res.status(400).json({ message: 'Invalid or expired verification token' });
        }

        const user = result.rows[0];

        // Mark verified and clear token
        await db.query('UPDATE users SET is_verified = TRUE, verification_token = NULL WHERE id = $1', [user.id]);
        
        // Trigger referral reward
        await referralService.rewardReferrer(user.id);
        
        invalidateUserCache(user.id);

        res.json({ message: 'Email verified successfully' });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ message: 'Error verifying email' });
    }
};

export const verifyRegistration = async (req: express.Request, res: express.Response) => {
    const { email, emailOtp } = req.body;

    if (!email || !emailOtp) {
        return res.status(400).json({ message: 'Email and OTP code are required.' });
    }

    try {
        const normEmail = String(email).toLowerCase();

        // Check Database for matching User and OTP
        const result = await db.query('SELECT id, verification_token FROM users WHERE email = $1', [normEmail]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const user = result.rows[0];

        if (user.verification_token !== String(emailOtp).trim()) {
            return res.status(400).json({ message: 'Invalid or expired verification code.' });
        }

        // Mark email as verified
        await db.query(
            'UPDATE users SET is_verified = TRUE, verification_token = NULL WHERE id = $1',
            [user.id]
        );

        // Trigger referral reward
        await referralService.rewardReferrer(user.id);
        
        invalidateUserCache(user.id);

        // Fetch user's name and send a welcome email (fire-and-forget)
        db.query('SELECT name FROM users WHERE id = $1', [user.id]).then(r => {
            const name = r.rows[0]?.name || 'there';
            sendWelcomeEmail(normEmail, name).catch(e => console.error('[email] Failed to send welcome email:', e));
        }).catch(() => { });

        res.status(200).json({ message: 'Email verified successfully.' });
    } catch (error) {
        console.error('Verify registration error:', error);
        res.status(500).json({ message: 'Internal server error during verification.' });
    }
};

export const resendVerificationEmail = async (req: express.Request, res: express.Response) => {
    // Requires auth usually, or email
    const { email } = req.body;
    // Or if logged in: const email = req.user?.email;

    // Let's support both for flexibility, prioritizing req.user if protected
    const targetEmail = (req as any).user?.email || email;

    if (!targetEmail) return res.status(400).json({ message: 'Email is required' });

    try {
        console.log(`[resend-verification] Attempting to resend for: ${targetEmail}`);
        const result = await db.query('SELECT id, is_verified FROM users WHERE email = $1', [targetEmail]);
        if (result.rowCount === 0) {
            console.warn(`[resend-verification] User not found for email: ${targetEmail}`);
            return res.status(404).json({ message: 'User not found' });
        }

        const user = result.rows[0];
        if (user.is_verified) {
            console.log(`[resend-verification] User ${targetEmail} is already verified.`);
            return res.status(400).json({ message: 'Email already verified' });
        }

        const newToken = generateOTP();
        console.log(`[resend-verification] Generated new OTP: ${newToken} for user: ${user.id}`);

        await db.query('UPDATE users SET verification_token = $1 WHERE id = $2', [newToken, user.id]);
        console.log(`[resend-verification] Database updated with new token.`);

        const sent = await sendOTPVerificationEmail(targetEmail, newToken);
        if (!sent) {
            // The email transport is configured but rejected/failed — telling the
            // user "sent" here would strand them at the OTP screen.
            return res.status(502).json({ message: 'We could not send the verification email. Please try again shortly.' });
        }

        res.json({ message: 'Verification email sent' });
    } catch (error: any) {
        console.error('Resend error:', error);
        res.status(500).json({
            message: 'Error resending email',
            details: error.message
        });
    }
};

export const forgotPassword = async (req: express.Request, res: express.Response) => {
    const { email } = req.body;
    const normEmail = String(email).toLowerCase();

    try {
        const result = await db.query('SELECT id FROM users WHERE email = $1', [normEmail]);
        if ((result.rowCount ?? 0) > 0) {
            const user = result.rows[0];
            const resetToken = generateRandomToken();
            const expires = new Date(Date.now() + 3600000); // 1 hour

            await db.query('UPDATE users SET reset_password_token = $1, reset_password_expires = $2 WHERE id = $3',
                [resetToken, expires.toISOString(), user.id]);

            await sendPasswordResetEmail(normEmail, resetToken);
            console.log(`Password reset link sent to ${normEmail}`);
        } else {
            console.log(`Password reset requested for non-existent email: ${normEmail}`);
        }
        // Always return success to prevent enumeration
        res.status(200).json({ message: 'If an account with that email exists, a password reset link has been sent.' });
    } catch (error) {
        console.error('Forgot password error:', error);
        res.status(500).json({ message: 'Error processing request' });
    }
};

export const resetPassword = async (req: express.Request, res: express.Response) => {
    const { token, newPassword } = req.body;

    if (!token || !newPassword || newPassword.length < 8) {
        return res.status(400).json({ message: 'Invalid input. Password must be at least 8 chars.' });
    }

    try {
        const result = await db.query(
            'SELECT id FROM users WHERE reset_password_token = $1 AND reset_password_expires > NOW()',
            [token]
        );

        if (result.rowCount === 0) {
            return res.status(400).json({ message: 'Invalid or expired password reset token' });
        }

        const user = result.rows[0];
        const salt = await bcrypt.genSalt(10);
        const password_hash = await bcrypt.hash(newPassword, salt);

        // A reset is the recovery path for an account the owner may have lost
        // control of, so every session already out there has to die with the
        // old password — otherwise whoever prompted the reset keeps their
        // 30-day token. Bumped in the same statement so a password can never
        // land without its revocation.
        await db.query(
            `UPDATE users
                SET password_hash = $1,
                    reset_password_token = NULL,
                    reset_password_expires = NULL,
                    token_version = token_version + 1
              WHERE id = $2`,
            [password_hash, user.id]
        );
        invalidateUserCache(user.id);

        // No token is issued here: this flow is unauthenticated (it runs from
        // an emailed link), so the user signs in again with the new password.
        res.json({ message: 'Password has been reset successfully' });
    } catch (error) {
        console.error('Reset password error:', error);
        res.status(500).json({ message: 'Error resetting password' });
    }
};

export const changePassword = async (req: express.Request, res: express.Response) => {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user!.id;

    if (!currentPassword || !newPassword || newPassword.length < 8) {
        return res.status(400).json({ message: 'Invalid input. New password must be at least 8 characters.' });
    }

    try {
        const result = await db.query('SELECT password_hash FROM users WHERE id = $1', [userId]);
        const user = result.rows[0];

        if (!user || !(await bcrypt.compare(currentPassword, user.password_hash))) {
            return res.status(401).json({ message: 'Invalid current password.' });
        }

        const salt = await bcrypt.genSalt(10);
        const new_password_hash = await bcrypt.hash(newPassword, salt);

        // Changing a password signs out everywhere else — the point of the
        // change is usually that somebody else may have had it. The caller is
        // the exception: they are standing right here and proved the old
        // password, so they get a token carrying the new version and stay
        // signed in on this device while every other session is stranded.
        const result2 = await db.query(
            `UPDATE users
                SET password_hash = $1,
                    token_version = token_version + 1
              WHERE id = $2
              RETURNING token_version`,
            [new_password_hash, userId]
        );
        invalidateUserCache(userId);

        const reissued = generateToken(userId, result2.rows[0]?.token_version ?? 0);
        // The cookie must be replaced as well, not just the body token: the
        // bump above just invalidated the token the browser is holding, so
        // without this a cookie-based session is signed out by its own
        // password change — the exact thing the reissue exists to prevent.
        setSessionCookies(res, reissued);

        res.status(200).json({
            message: 'Password changed successfully.',
            // Clients that persist this keep their session; a client that
            // ignores it simply lands on a 401 and signs in again.
            token: reissued,
            otherSessionsEnded: true,
        });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ message: 'Server error changing password' });
    }
};




export const googleLogin = async (req: express.Request, res: express.Response) => {
    const { idToken, role: requestedRole } = req.body;
    if (!idToken) {
        return res.status(400).json({ message: 'Missing idToken' });
    }

    try {
        // Correctly verify Firebase ID Token using Identity Toolkit API
        // This validates that the token was signed by Firebase (Google) for THIS specific project
        const apiKey = "AIzaSyBqcS-rap5P5jRl7nhfdESKWEJtZb4Zy8c"; // Hardcoded from firebase.ts because importing generated circular deps or module issues occasionally
        const verifyUrl = `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`;

        const googleRes = await fetch(verifyUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken })
        });

        if (!googleRes.ok) {
            const errorData = await googleRes.json();
            console.error('Firebase token validation failed:', errorData);
            return res.status(401).json({ message: 'Invalid Google token' });
        }

        const payload = await googleRes.json();
        // Identity Toolkit returns { users: [ { localId, email, displayName, photoUrl, ... } ] }
        const googleUser = payload.users?.[0];

        if (!googleUser || !googleUser.email) {
            return res.status(400).json({ message: 'Google account has no email' });
        }

        const email = googleUser.email;
        const name = googleUser.displayName;
        const normEmail = String(email).toLowerCase();
        const profilePicture = googleUser.photoUrl || null;
        // Trust the identity provider's own verification signal. Real Google
        // sign-ins carry a verified email; only treat it as unverified if the
        // provider explicitly says so. This keeps the "no unverified sessions"
        // guarantee consistent across the password and Google paths.
        const emailVerified = googleUser.emailVerified !== false;

        // Check if user exists
        const result = await db.query(`
            SELECT u.*, s.status AS store_status, s.subscription_status, s.subscription_ends_at, s.subscription_plan
            FROM users u
            LEFT JOIN stores s ON u.current_store_id = s.id 
            WHERE u.email = $1
        `, [normEmail]);
        let user = result.rows[0];

        if (!user) {
            // Create new user (Role: customer by default)
            const id = generateId('user');
            // Placeholder password for a Google-only account: nobody ever uses
            // it, but it must be unguessable, because anyone who can predict it
            // can sign in with password auth as this user. Math.random() gave
            // ~41 bits from a recoverable PRNG stream; this gives 256 bits.
            const randomPassword = crypto.randomBytes(32).toString('hex');
            const salt = await bcrypt.genSalt(10);
            const password_hash = await bcrypt.hash(randomPassword, salt);

            let role = 'customer';
            if (requestedRole === 'business') {
                role = 'staff';
            } else if (requestedRole === 'customer') {
                role = 'customer';
            }

            const insertResult = await db.query(
                'INSERT INTO users(id, name, email, password_hash, role, profile_picture, is_verified) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, role, phone, profile_picture, is_verified',
                [id, String(name || 'Google User'), normEmail, password_hash, role, profilePicture, emailVerified]
            );
            user = insertResult.rows[0];
        } else {
            // If the user exists but is unverified, only promote them to verified
            // when the identity provider confirms the email. This prevents Google
            // sign-in from being used to skip verification on an account whose
            // email the provider has NOT verified.
            if (!user.is_verified && emailVerified) {
                await db.query('UPDATE users SET is_verified = TRUE WHERE id = $1', [user.id]);
                user.is_verified = true;
                invalidateUserCache(user.id);
            }
            
            if (profilePicture && user.profile_picture !== profilePicture) {
                // Update profile picture if it has changed
                await db.query('UPDATE users SET profile_picture = $1 WHERE id = $2', [profilePicture, user.id]);
                user.profile_picture = profilePicture;
            }
        }

        // Generate App Token using EXISTING logic. A just-inserted row has no
        // token_version in its RETURNING list, which falls through to the
        // parameter default of 0 — the same value the column defaults to.
        const token = generateToken(user.id, user.token_version);
        setSessionCookies(res, token);

        const userResponse = toCamelCase({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            phone: user.phone,
            profile_picture: user.profile_picture,
            current_store_id: user.current_store_id,
            token: token,
            is_verified: user.is_verified,
            store_status: user.store_status,
        });
        return res.json(userResponse);

    } catch (error) {
        console.error('Google login error:', error);
        return res.status(500).json({ message: 'Server error during Google login' });
    }
};

/**
 * POST /auth/sign-out-everywhere
 *
 * Ends every session for the calling account, including this one. This is the
 * control a user needs after losing a phone or a till: before token_version
 * existed there was no way to take a 30-day token back, and "logging out" only
 * dropped the copy held by the browser doing it.
 *
 * The caller is signed out too, deliberately — an attacker who has a token
 * could otherwise use this to strand the real owner while keeping their own
 * access. Everyone signs in again.
 */
export const signOutEverywhere = async (req: express.Request, res: express.Response) => {
    try {
        const userId = req.user!.id;
        await revokeUserSessions(userId);
        // This device is one of the devices: its cookie now holds a stranded
        // token, so clear it rather than leaving the browser to discover that
        // on its next request.
        clearSessionCookies(res);
        return res.status(200).json({
            message: 'Signed out on all devices. Please sign in again.',
            signedOutEverywhere: true,
        });
    } catch (error) {
        console.error('Sign-out-everywhere error:', error);
        return res.status(500).json({ message: 'Could not sign out other sessions' });
    }
};


/**
 * POST /auth/logout
 *
 * Clears the session cookies for this browser. There was no server-side logout
 * before, because the token lived in localStorage and the client could simply
 * drop it — an httpOnly cookie is precisely the thing a client CANNOT drop by
 * itself, so this endpoint has to exist.
 *
 * Deliberately not a revocation: this ends the session on this device only and
 * leaves other devices signed in. `/auth/sign-out-everywhere` is the one that
 * strands every token.
 *
 * Unauthenticated on purpose — clearing a cookie you already hold needs no
 * proof of anything, and an expired session must still be able to tidy up.
 */
export const logout = async (_req: express.Request, res: express.Response) => {
    clearSessionCookies(res);
    return res.status(200).json({ message: 'Signed out.' });
};
