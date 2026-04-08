import db from '../db_client';
import { sendEmail } from './email.service';
import { generateId, toCamelCase } from '../utils/helpers';

const TIPS = [
    {
        id: 'tip_logo',
        day: 1,
        subject: 'Tip #1: Professionalize your receipts with a logo! 🖼️',
        content: 'Did you know you can upload your company logo in Settings? It will appear on all your digital and printed receipts, giving your business a professional look.'
    },
    {
        id: 'tip_reports',
        day: 3,
        subject: 'Tip #2: Track your business health! 📊',
        content: 'Check out the Reports section to see your daily profit and loss, sales trends, and inventory value in real time. Staying on top of your numbers is key to growth!'
    },
    {
        id: 'tip_referral',
        day: 7,
        subject: 'Tip #3: Earn discounts with our referral program! 💸',
        content: 'Love using SalePilot? Refer a friend using your unique referral code and get a ZMW 20 discount on your next month\'s subscription for every person who signs up!'
    }
];

export const notificationSchedulerService = {
    /**
     * Finds users due for a tip and sends it.
     */
    sendPeriodicTips: async () => {
        console.log('[scheduler] Starting periodic tips job...');
        try {
            // Find users and their registration dates
            // We'll approximate registration date from the 'user-' ID timestamp or created_at if we had it.
            // Since we don't have created_at on users yet, let's add it or use ID.
            // Wait, I should have added created_at to users in init_db.
            
            const usersResult = await db.query(`
                SELECT id, name, email, referral_code, 
                (EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(CAST(SPLIT_PART(id, '-', 2) AS BIGINT) / 1000.0))) / 86400)::INT as days_since_reg
                FROM users 
                WHERE id LIKE 'user-%' AND is_verified = TRUE
            `);

            const users = usersResult.rows;

            for (const user of users) {
                const days = user.days_since_reg;
                const relevantTips = TIPS.filter(tip => tip.day === days);

                for (const tip of relevantTips) {
                    // Check if already sent
                    const logResult = await db.query(
                        'SELECT id FROM periodic_notification_logs WHERE user_id = $1 AND notification_type = $2',
                        [user.id, tip.id]
                    );

                    if (logResult.rowCount === 0) {
                        try {
                            const html = `
                                <div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:32px 24px;background:#f8fafc;border-radius:16px;">
                                    <h2 style="color:#0f172a;margin-bottom:16px;">${tip.subject}</h2>
                                    <p style="color:#475569;font-size:16px;line-height:1.6;">Hi ${user.name},</p>
                                    <p style="color:#475569;font-size:16px;line-height:1.6;">${tip.content}</p>
                                    <div style="margin-top:24px;padding-top:24px;border-top:1px solid #e2e8f0;">
                                        <p style="color:#94a3b8;font-size:14px;">Your referral code: <strong>${user.referral_code || 'N/A'}</strong></p>
                                    </div>
                                    <div style="text-align:center;margin-top:32px;">
                                        <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}" style="background:#0284c7;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;">Open SalePilot</a>
                                    </div>
                                </div>
                            `;

                            await sendEmail(user.email, tip.subject, html, tip.content);
                            
                            // Log it
                            await db.query(
                                'INSERT INTO periodic_notification_logs (id, user_id, notification_type) VALUES ($1, $2, $3)',
                                [generateId('notlog'), user.id, tip.id]
                            );
                            console.log(`[scheduler] Sent ${tip.id} to ${user.email}`);
                        } catch (sendErr) {
                            console.error(`[scheduler] Failed to send ${tip.id} to ${user.email}:`, sendErr);
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[scheduler] Error in periodic tips job:', error);
        }
    }
};
