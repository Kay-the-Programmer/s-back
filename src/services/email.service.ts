import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
    service: process.env.EMAIL_SERVICE || 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

export const sendVerificationEmail = async (email: string, token: string) => {
    const verificationUrl = `${process.env.FRONTEND_URL}/auth/verify-email?token=${token}`;

    const mailOptions = {
        from: `"SalePilot" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Verify your email address',
        html: `
            <h1>Welcome to SalePilot!</h1>
            <p>Please click the button below to verify your email address and activate your account.</p>
            <a href="${verificationUrl}" style="background-color: #2563eb; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Verify Email</a>
            <p>Or copy and paste this link:</p>
            <p>${verificationUrl}</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Verification email sent to ${email}`);
    } catch (error) {
        console.error('Error sending verification email:', error);
        throw new Error('Failed to send verification email');
    }
};

export const sendPasswordResetEmail = async (email: string, token: string) => {
    const resetUrl = `${process.env.FRONTEND_URL}/auth/reset-password?token=${token}`;

    const mailOptions = {
        from: `"SalePilot" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Reset your password',
        html: `
            <h1>Password Reset Request</h1>
            <p>You requested to reset your password. Click the button below to proceed.</p>
            <a href="${resetUrl}" style="background-color: #dc2626; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Reset Password</a>
            <p>If you did not request this, please ignore this email.</p>
            <p>Link expires in 1 hour.</p>
        `,
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`Password reset email sent to ${email}`);
    } catch (error) {
        console.error('Error sending password reset email:', error);
        throw new Error('Failed to send password reset email');
    }
};
