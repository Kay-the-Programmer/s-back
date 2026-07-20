import nodemailer from 'nodemailer';
import { adminDb } from '../firebase';
import dns from 'node:dns';
import { appUrl } from '../utils/helpers';

// Force node to resolve IPv4 addresses first to avoid ENETUNREACH when attempting to connect to IPv6 servers like smtp.gmail.com
dns.setDefaultResultOrder('ipv4first');

// ─── Sender identity ───────────────────────────────────────────────────────────
// Brevo requires the sender to be a verified sender/domain in the Brevo account.
// EMAIL_FROM / EMAIL_FROM_NAME win; otherwise SMTP_FROM ('"Name" <addr>') is parsed.
const getSender = (): { name: string; email: string } => {
    const raw = process.env.SMTP_FROM || '"SalePilot" <noreply@salepilot.com>';
    const match = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
    return {
        name: process.env.EMAIL_FROM_NAME || (match?.[1]?.trim() || 'SalePilot'),
        email: process.env.EMAIL_FROM || (match?.[2]?.trim() || raw.trim()),
    };
};

// ─── Transport 1: Brevo HTTPS API ──────────────────────────────────────────────
// Free-tier hosts (Render, Railway, …) block outbound SMTP ports entirely, so
// when BREVO_API_KEY is set we send over HTTPS (port 443) instead. Takes
// priority over SMTP wherever both are configured.
const sendViaBrevo = async (to: string, subject: string, html: string, text?: string): Promise<boolean> => {
    try {
        const sender = getSender();
        const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
            method: 'POST',
            headers: {
                'api-key': process.env.BREVO_API_KEY as string,
                'Content-Type': 'application/json',
                accept: 'application/json',
            },
            body: JSON.stringify({
                sender,
                to: [{ email: to }],
                subject,
                htmlContent: html,
                ...(text ? { textContent: text } : {}),
            }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            console.error(`[email] Brevo API error ${resp.status} for "${subject}" -> ${to}: ${body.slice(0, 300)}`);
            return false;
        }
        const data: any = await resp.json().catch(() => ({}));
        console.log(`[email] Sent via Brevo: ${data.messageId || '(no id)'} -> ${to}`);
        return true;
    } catch (error) {
        console.error('[email] Error sending email via Brevo:', error);
        return false;
    }
};

// ─── Transport 2: SMTP (nodemailer) ────────────────────────────────────────────
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
        // Fail fast instead of nodemailer's 2-minute default — a blocked SMTP port
        // otherwise stalls the scheduler for minutes per email.
        connectionTimeout: 15_000,
        greetingTimeout: 10_000,
        socketTimeout: 30_000,
    } as any);
};

/**
 * Send an email. Returns `true` when a transport accepted the message (or when
 * no transport is configured — dev mode, where the content is console-logged so
 * local flows keep working), `false` when a configured transport failed, so
 * callers on critical paths (registration OTP) can tell the user honestly.
 */
export const sendEmail = async (to: string, subject: string, html: string, text?: string): Promise<boolean> => {
    // Preferred: HTTPS API — works on hosts that block outbound SMTP.
    if (process.env.BREVO_API_KEY) {
        return sendViaBrevo(to, subject, html, text);
    }

    const transporter = getTransporter();

    // Fallback: If no transport configured, log the email content to console and still write to Firestore
    if (!transporter) {
        console.warn(`\n=== EMAIL NOT SENT (NO BREVO/SMTP CONFIG) ===\nTo: ${to}\nSubject: ${subject}\n\n${text || 'HTML Content (see below)\n' + html}\n=======================================\n`);

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
        return true;
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
        return true;
    } catch (error) {
        console.error('[email] Error sending email via Nodemailer:', error);
        return false;
    }
};

// ─── Shared branded shell ──────────────────────────────────────────────────────
// Mirrors the email-engine wrapper (email-template.service.ts): logo masthead on
// navy, white body card, muted footer. Colours/font per salepilot/DESIGN.md; the
// wordmark stays next to the logo image so image-blocking clients keep the brand.
const NAVY = '#002b6b';
const ORANGE = '#ff7f27';
const INK = '#181c1e';
const INK_MUTED = '#434651';
const CANVAS = '#f7fafc';
const HAIRLINE = '#c4c6d2';
const FONT = "'Hanken Grotesk','Helvetica Neue',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif";

const logoUrl = () => `${appUrl()}/images/salepilot.png`;

const brandShell = (bodyHtml: string): string => `
<div style="font-family:${FONT};max-width:600px;margin:0 auto;background:${CANVAS};padding:24px;">
  <div style="background:${NAVY};border-radius:8px 8px 0 0;padding:24px 28px;text-align:center;">
    <img src="${logoUrl()}" alt="SalePilot" width="48" height="48" style="display:block;margin:0 auto 10px;border:0;border-radius:12px;" />
    <span style="color:#ffffff;font-size:22px;font-weight:700;letter-spacing:-0.02em;">Sale<span style="color:${ORANGE};">Pilot</span></span>
  </div>
  <div style="background:#ffffff;padding:32px 28px;border:1px solid ${HAIRLINE};border-top:0;">
    ${bodyHtml}
  </div>
  <div style="text-align:center;padding:18px;color:${INK_MUTED};font-size:12px;">
    © ${new Date().getFullYear()} SalePilot · <a href="${appUrl()}" style="color:${NAVY};text-decoration:none;font-weight:600;">salepilot.space</a>
  </div>
</div>`.trim();

const ctaButton = (href: string, label: string): string =>
    `<div style="text-align:center;margin:8px 0 4px;"><a href="${href}" style="display:inline-block;background:${ORANGE};color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;line-height:20px;padding:14px 32px;border-radius:8px;">${label}</a></div>`;

function buildOtpHtml(otp: string): string {
    return brandShell(`
    <h1 style="margin:0 0 12px;color:${INK};font-size:24px;font-weight:600;line-height:32px;letter-spacing:-0.01em;">Verify your email</h1>
    <p style="margin:0 0 20px;color:${INK_MUTED};font-size:16px;line-height:24px;">Enter this code in SalePilot to complete your registration:</p>
    <div style="background:${CANVAS};border:1px solid ${HAIRLINE};padding:20px 32px;border-radius:8px;text-align:center;margin:0 0 20px;">
        <span style="font-size:36px;font-weight:800;letter-spacing:0.35em;color:${NAVY};">${otp}</span>
    </div>
    <p style="margin:0;color:${INK_MUTED};font-size:14px;line-height:20px;">Code expires in 24&nbsp;hours. If you didn't sign up for SalePilot, ignore this email.</p>`);
}

// ─── Verification link email ───────────────────────────────────────────────────
export const sendVerificationEmail = async (email: string, token: string) => {
    const verificationUrl = `${appUrl()}/auth/verify-email?token=${token}`;
    const subject = 'Verify your email address';
    const html = brandShell(`
    <h1 style="margin:0 0 12px;color:${INK};font-size:24px;font-weight:600;line-height:32px;letter-spacing:-0.01em;">Welcome to SalePilot!</h1>
    <p style="margin:0 0 20px;color:${INK_MUTED};font-size:16px;line-height:24px;">Click below to verify your email and activate your account.</p>
    ${ctaButton(verificationUrl, 'Verify email')}
    <p style="margin:20px 0 0;color:${INK_MUTED};font-size:13px;line-height:20px;word-break:break-all;">Or copy this link: <a href="${verificationUrl}" style="color:${NAVY};">${verificationUrl}</a></p>`);

    await sendEmail(email, subject, html);
};

// ─── OTP Verification email ────────────────────────────────────────────────────
export const sendOTPVerificationEmail = async (email: string, otp: string): Promise<boolean> => {
    const subject = 'Your SalePilot Verification Code';
    const text = `Your SalePilot verification code is: ${otp}`;
    const html = buildOtpHtml(otp);

    return sendEmail(email, subject, html, text);
};

// ─── Store OTP Verification email ──────────────────────────────────────────────
export const sendStoreOTPVerificationEmail = async (email: string, storeName: string, otp: string): Promise<boolean> => {
    const subject = 'Verify your new SalePilot store';
    const text = `Your verification code for ${storeName} is: ${otp}`;
    const html = buildOtpHtml(otp);

    return sendEmail(email, subject, html, text);
};

// ─── Password reset email ──────────────────────────────────────────────────────
export const sendPasswordResetEmail = async (email: string, token: string) => {
    const resetUrl = `${appUrl()}/auth/reset-password?token=${token}`;
    const subject = 'Reset your SalePilot password';
    const html = brandShell(`
    <h1 style="margin:0 0 12px;color:${INK};font-size:24px;font-weight:600;line-height:32px;letter-spacing:-0.01em;">Password reset request</h1>
    <p style="margin:0 0 20px;color:${INK_MUTED};font-size:16px;line-height:24px;">Click below to reset your password. This link expires in 1 hour.</p>
    ${ctaButton(resetUrl, 'Reset password')}
    <p style="margin:20px 0 0;color:${INK_MUTED};font-size:14px;line-height:20px;">If you didn't request this, you can safely ignore this email.</p>`);

    await sendEmail(email, subject, html);
};

// ─── Welcome email after verification ─────────────────────────────────────────
export const sendWelcomeEmail = async (email: string, name: string) => {
    const subject = 'Welcome to SalePilot! 🎉 Your email is verified';
    const text = `Hi ${name}, your SalePilot account has been successfully verified. You now have full access to all features.`;
    const html = brandShell(`
    <h1 style="margin:0 0 12px;color:${INK};font-size:24px;font-weight:600;line-height:32px;letter-spacing:-0.01em;text-align:center;">You're all set, ${name}!</h1>
    <p style="margin:0 0 24px;color:${INK_MUTED};font-size:16px;line-height:24px;text-align:center;">Your email has been successfully verified. Welcome to SalePilot — your business management platform.</p>
    <div style="background:${CANVAS};border:1px solid ${HAIRLINE};padding:20px 24px;border-radius:8px;margin:0 0 24px;">
        <p style="margin:0 0 12px;font-size:14px;font-weight:700;color:${INK};">Here's what you can do now:</p>
        <ul style="margin:0;padding-left:20px;color:${INK_MUTED};font-size:14px;line-height:2;">
            <li>Set up your store and start adding inventory</li>
            <li>Process sales and track revenue in real time</li>
            <li>Manage customers, suppliers, and purchase orders</li>
            <li>Generate reports and financial summaries</li>
        </ul>
    </div>
    ${ctaButton(appUrl(), 'Go to Dashboard →')}
    <p style="margin:20px 0 0;color:${INK_MUTED};font-size:13px;line-height:20px;text-align:center;">If you have any questions, reply to this email or visit our support page.</p>`);

    await sendEmail(email, subject, html, text);
};
