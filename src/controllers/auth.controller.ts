import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import db from '../db_client';
import { User } from '../types';
import { generateId, toCamelCase } from '../utils/helpers';
import express from 'express';
import { signInWithEmailAndPassword, signInWithPhoneNumber } from "firebase/auth";
import { authentication } from "../firebase";

// Use a safe fallback to avoid runtime 500s if JWT_SECRET is missing in env.
// In production, set JWT_SECRET in your hosting provider (Render) dashboard.
const JWT_SECRET = process.env.JWT_SECRET || 'CHANGE_ME_DEV_ONLY';

const generateToken = (id: string) => {
    return jwt.sign({ id }, JWT_SECRET, {
        expiresIn: '30d',
    });
};

import crypto from 'crypto';
import { sendVerificationEmail, sendPasswordResetEmail } from '../services/email.service';

// Helper to generate random token
const generateRandomToken = () => {
    return crypto.randomBytes(32).toString('hex');
};

export const loginUser = async (req: express.Request, res: express.Response) => {
    const { email, password } = req.body || {};
    try {
        if (!email || !password) {
            return res.status(400).json({ message: 'Email and password are required' });
        }
        const normEmail = String(email).toLowerCase();
        const result = await db.query('SELECT * FROM users WHERE email = $1', [normEmail]);
        const user = result.rows[0];

        if (user && user.password_hash && (await bcrypt.compare(String(password), user.password_hash))) {
            const userResponse = toCamelCase({
                id: user.id,
                name: user.name,
                email: user.email,
                role: user.role,
                phone: user.phone,
                current_store_id: user.current_store_id,
                is_verified: user.is_verified, // Return verification status
                token: generateToken(user.id),
            });
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

        // Generate verification token
        const verificationToken = generateRandomToken();

        const insertResult = await db.query(
            'INSERT INTO users(id, name, email, password_hash, role, verification_token, is_verified) VALUES($1, $2, $3, $4, $5, $6, $7) RETURNING id, name, email, role, phone, is_verified',
            [id, String(name), normEmail, password_hash, role, verificationToken, false]
        );
        const newUser = insertResult.rows[0];

        // Send verification email
        try {
            await sendVerificationEmail(newUser.email, verificationToken);
        } catch (emailError) {
            console.error('Failed to send verification email:', emailError);
            // Don't fail registration, just log it. User can request resend.
        }

        const userResponse = toCamelCase({
            ...newUser,
            token: generateToken(newUser.id),
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
        const verificationToken = generateRandomToken();

        const insertResult = await db.query(
            'INSERT INTO users(id, name, email, password_hash, role, phone, verification_token, is_verified) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, role, phone, is_verified',
            [id, String(name), normEmail, password_hash, role, phone || null, verificationToken, false]
        );
        const newUser = insertResult.rows[0];

        // Send verification email
        try {
            await sendVerificationEmail(newUser.email, verificationToken);
        } catch (e) { console.error('Email send failed', e); }

        const userResponse = toCamelCase({
            ...newUser,
            token: generateToken(newUser.id),
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
        const verificationToken = generateRandomToken();

        const insertResult = await db.query(
            'INSERT INTO users(id, name, email, password_hash, role, phone, verification_token, is_verified) VALUES($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, name, email, role, phone, is_verified',
            [id, String(name), normEmail, password_hash, role, phone || null, verificationToken, false]
        );
        const newUser = insertResult.rows[0];

        try {
            await sendVerificationEmail(newUser.email, verificationToken);
        } catch (e) { console.error('Email send failed', e); }

        const userResponse = toCamelCase({
            ...newUser,
            token: generateToken(newUser.id),
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

        res.json({ message: 'Email verified successfully' });
    } catch (error) {
        console.error('Verification error:', error);
        res.status(500).json({ message: 'Error verifying email' });
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
        const result = await db.query('SELECT id, is_verified FROM users WHERE email = $1', [targetEmail]);
        if (result.rowCount === 0) return res.status(404).json({ message: 'User not found' });

        const user = result.rows[0];
        if (user.is_verified) return res.status(400).json({ message: 'Email already verified' });

        const newToken = generateRandomToken();
        await db.query('UPDATE users SET verification_token = $1 WHERE id = $2', [newToken, user.id]);

        await sendVerificationEmail(targetEmail, newToken);
        res.json({ message: 'Verification email sent' });
    } catch (error) {
        console.error('Resend error:', error);
        res.status(500).json({ message: 'Error resending email' });
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

        await db.query(
            'UPDATE users SET password_hash = $1, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $2',
            [password_hash, user.id]
        );

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

        await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [new_password_hash, userId]);

        res.status(200).json({ message: 'Password changed successfully.' });
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

        // Check if user exists
        const result = await db.query('SELECT * FROM users WHERE email = $1', [normEmail]);
        let user = result.rows[0];

        if (!user) {
            // Create new user (Role: customer by default)
            const id = generateId('user');
            // Generate a random high-entropy password since they login with Google
            const randomPassword = Math.random().toString(36).slice(-8) + Math.random().toString(36).slice(-8);
            const salt = await bcrypt.genSalt(10);
            const password_hash = await bcrypt.hash(randomPassword, salt);

            let role = 'customer';
            if (requestedRole === 'business') {
                role = 'staff';
            } else if (requestedRole === 'customer') {
                role = 'customer';
            }

            const insertResult = await db.query(
                'INSERT INTO users(id, name, email, password_hash, role) VALUES($1, $2, $3, $4, $5) RETURNING id, name, email, role, phone',
                [id, String(name || 'Google User'), normEmail, password_hash, role]
            );
            user = insertResult.rows[0];
        }

        // Generate App Token using EXISTING logic
        const token = generateToken(user.id);

        const userResponse = toCamelCase({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            phone: user.phone,
            current_store_id: user.current_store_id,
            token: token,
        });
        return res.json(userResponse);

    } catch (error) {
        console.error('Google login error:', error);
        return res.status(500).json({ message: 'Server error during Google login' });
    }
};