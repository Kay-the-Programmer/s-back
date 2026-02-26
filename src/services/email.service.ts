import nodemailer from 'nodemailer';
import { adminDb } from '../firebase';

// ─── Nodemailer transporter ────────────────────────────────────────────────────
// Reads EMAIL_SERVICE / EMAIL_USER / EMAIL_PASS from environment.
// For Gmail: set EMAIL_USER=you@gmail.com, EMAIL_PASS=app-password
const createTransporter = () => nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

// ─── Verification link email ───────────────────────────────────────────────────
export const sendVerificationEmail = async (email: string, token: string) => {
    const verificationUrl = `${process.env.FRONTEND_URL}/auth/verify-email?token=${token}`;
    const transporter = createTransporter();
    await transporter.sendMail({
        from: `"SalePilot" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Verify your email address',
        html: `
            <h1>Welcome to SalePilot!</h1>
            <p>Click below to verify your email and activate your account.</p>
            <a href="${verificationUrl}" style="background-color:#2563eb;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Verify Email</a>
            <p>Or copy this link: ${verificationUrl}</p>
        `,
    });
    console.log(`[email] Verification email sent to ${email}`);
};

// ─── OTP Verification email ────────────────────────────────────────────────────
// Tries Firebase Trigger Email (Firestore) first if adminDb is available.
// Falls back to nodemailer if Firebase Admin SDK is not configured.
export const sendOTPVerificationEmail = async (email: string, otp: string) => {

    // ── Path A: Firebase Trigger Email (preferred in production) ──────────────
    if (adminDb) {
        try {
            await adminDb.collection('mail').add({
                to: email,
                message: {
                    subject: 'Your SalePilot Verification Code',
                    text: `Your SalePilot verification code is: ${otp}`,
                    html: buildOtpHtml(otp),
                },
            });
            console.log(`[email] OTP queued via Firebase Trigger Email for ${email}`);
            return;
        } catch (firestoreError) {
            console.error('[email] Firebase Trigger Email failed, falling back to nodemailer:', firestoreError);
        }
    }

    // ── Path B: Direct nodemailer (dev / fallback) ────────────────────────────
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
        console.error(
            '[email] CRITICAL: Cannot send OTP email — no delivery method is configured.\n' +
            '  Option 1: Set FIREBASE_SERVICE_ACCOUNT to enable Firebase Trigger Email.\n' +
            '  Option 2: Set EMAIL_USER and EMAIL_PASS to use Gmail/SMTP directly.\n' +
            `  OTP for ${email}: ${otp}` // Visible in backend logs so you can test manually
        );
        // Don't throw — the user was registered; they can use resend later.
        return;
    }

    const transporter = createTransporter();
    await transporter.sendMail({
        from: `"SalePilot" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Your SalePilot Verification Code',
        html: buildOtpHtml(otp),
    });
    console.log(`[email] OTP sent via nodemailer to ${email}`);
};

// ─── Password reset email ──────────────────────────────────────────────────────
export const sendPasswordResetEmail = async (email: string, token: string) => {
    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;
    const transporter = createTransporter();
    await transporter.sendMail({
        from: `"SalePilot" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Reset your SalePilot password',
        html: `
            <h1>Password Reset Request</h1>
            <p>Click below to reset your password. This link expires in 1 hour.</p>
            <a href="${resetUrl}" style="background-color:#dc2626;color:white;padding:10px 20px;text-decoration:none;border-radius:5px;">Reset Password</a>
            <p>If you didn't request this, you can safely ignore this email.</p>
        `,
    });
    console.log(`[email] Password reset email sent to ${email}`);
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
