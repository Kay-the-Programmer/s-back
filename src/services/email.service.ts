import nodemailer from 'nodemailer';
import { adminDb } from '../firebase';
import dns from 'node:dns';

// Force node to resolve IPv4 addresses first to avoid ENETUNREACH when attempting to connect to IPv6 servers like smtp.gmail.com
dns.setDefaultResultOrder('ipv4first');

// ─── Nodemailer Configuration ──────────────────────────────────────────────────
const getTransporter = () => {
    // If SMTP environment variables are not set, return null
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
        return null;
    }

    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
        // Force IPv4 if IPv6 is unreachable (fixes ENETUNREACH / ETIMEDOUT for Gmail)
        family: 4,
    } as any);
};

const sendEmail = async (to: string, subject: string, html: string, text?: string) => {
    const transporter = getTransporter();

    // Fallback: If no SMTP configured, log the email content to console and still write to Firestore
    if (!transporter) {
        console.warn(`\n=== EMAIL NOT SENT (NO SMTP CONFIG) ===\nTo: ${to}\nSubject: ${subject}\n\n${text || 'HTML Content (see below)\n' + html}\n=======================================\n`);

        // Optionally keep writing to Firestore for records, but don't fail if it doesn't work.
        if (adminDb) {
            try {
                await adminDb.collection('mail_logs').add({
                    to,
                    subject,
                    html,
                    text,
                    timestamp: new Date()
                });
            } catch (e) { }
        }
        return;
    }

    try {
        const info = await transporter.sendMail({
            from: process.env.SMTP_FROM || '"SalePilot" <noreply@salepilot.com>',
            to,
            subject,
            text,
            html,
        });
        console.log(`[email] Message sent: ${info.messageId}`);
    } catch (error) {
        console.error('[email] Error sending email via Nodemailer:', error);
    }
};

// ─── Shared HTML template ──────────────────────────────────────────────────────
function buildOtpHtml(otp: string): string {
    return `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#f8fafc;border-radius:16px;">
            <h1 style="color:#0f172a;font-size:22px;margin-bottom:8px;">Verify your email</h1>
            <p style="color:#475569;font-size:15px;margin-bottom:24px;">Enter this code in SalePilot to complete your registration:</p>
            <div style="background:#fff;border:2px solid #e2e8f0;padding:20px 32px;border-radius:12px;text-align:center;margin-bottom:24px;">
                <span style="font-size:36px;font-weight:900;letter-spacing:0.35em;color:#0284c7;">${otp}</span>
            </div>
            <p style="color:#94a3b8;font-size:13px;">Code expires in 24&nbsp;hours. If you didn't sign up for SalePilot, ignore this email.</p>
        </div>
    `;
}

// ─── Verification link email ───────────────────────────────────────────────────
export const sendVerificationEmail = async (email: string, token: string) => {
    const verificationUrl = `${process.env.FRONTEND_URL}/auth/verify-email?token=${token}`;
    const subject = 'Verify your email address';
    const html = `
        <h1>Welcome to SalePilot!</h1>
        <p>Click below to verify your email and activate your account.</p>
        <a href="${verificationUrl}" style="background-color:#2563eb;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Verify Email</a>
        <p>Or copy this link: ${verificationUrl}</p>
    `;

    await sendEmail(email, subject, html);
};

// ─── OTP Verification email ────────────────────────────────────────────────────
export const sendOTPVerificationEmail = async (email: string, otp: string) => {
    const subject = 'Your SalePilot Verification Code';
    const text = `Your SalePilot verification code is: ${otp}`;
    const html = buildOtpHtml(otp);

    await sendEmail(email, subject, html, text);
};

// ─── Store OTP Verification email ──────────────────────────────────────────────
export const sendStoreOTPVerificationEmail = async (email: string, storeName: string, otp: string) => {
    const subject = 'Verify your new SalePilot store';
    const text = `Your verification code for ${storeName} is: ${otp}`;
    const html = buildOtpHtml(otp);

    await sendEmail(email, subject, html, text);
};

// ─── Password reset email ──────────────────────────────────────────────────────
export const sendPasswordResetEmail = async (email: string, token: string) => {
    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
    const subject = 'Reset your SalePilot password';
    const html = `
        <h1>Password Reset Request</h1>
        <p>Click below to reset your password. This link expires in 1 hour.</p>
        <a href="${resetUrl}" style="background-color:#dc2626;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Reset Password</a>
        <p>If you didn't request this, you can safely ignore this email.</p>
    `;

    await sendEmail(email, subject, html);
};

// ─── Welcome email after verification ─────────────────────────────────────────
export const sendWelcomeEmail = async (email: string, name: string) => {
    const subject = 'Welcome to SalePilot! 🎉 Your email is verified';
    const text = `Hi ${name}, your SalePilot account has been successfully verified. You now have full access to all features.`;
    const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#f8fafc;border-radius:16px;">
            <div style="text-align:center;margin-bottom:28px;">
                <div style="display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;background:#d1fae5;border-radius:16px;">
                    <span style="font-size:32px;">✅</span>
                </div>
            </div>
            <h1 style="color:#0f172a;font-size:22px;margin-bottom:8px;text-align:center;">You're all set, ${name}!</h1>
            <p style="color:#475569;font-size:15px;margin-bottom:24px;text-align:center;">Your email has been successfully verified. Welcome to SalePilot — your business management platform.</p>
            <div style="background:#fff;border:1px solid #e2e8f0;padding:20px 24px;border-radius:12px;margin-bottom:24px;">
                <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:#0f172a;">Here's what you can do now:</p>
                <ul style="margin:0;padding-left:20px;color:#475569;font-size:14px;line-height:2;">
                    <li>Set up your store and start adding inventory</li>
                    <li>Process sales and track revenue in real time</li>
                    <li>Manage customers, suppliers, and purchase orders</li>
                    <li>Generate reports and financial summaries</li>
                </ul>
            </div>
            <div style="text-align:center;">
                <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}" style="display:inline-block;background:#0284c7;color:white;padding:12px 28px;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px;">
                    Go to Dashboard →
                </a>
            </div>
            <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:28px;">If you have any questions, reply to this email or visit our support page.</p>
        </div>
    `;

    await sendEmail(email, subject, html, text);
};
