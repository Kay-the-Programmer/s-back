import db from '../db_client';
import { generateId } from '../utils/helpers';
import { getScheduledTipTemplates, sendTemplatedEmail } from './email-template.service';

export const notificationSchedulerService = {
    /**
     * Sends onboarding tip emails that are due.
     *
     * Tips are now configurable email templates (superadmin: /superadmin/emails):
     * each carries an editable subject/HTML, an on/off switch, and a "send N days
     * after signup" schedule. This job finds verified users whose account age (in
     * days) matches an enabled tip's send-day and hasn't received it yet, then
     * renders + sends it through the brand-consistent email engine.
     */
    sendPeriodicTips: async () => {
        console.log('[scheduler] Starting periodic tips job...');
        try {
            const tips = await getScheduledTipTemplates();
            if (tips.length === 0) return;

            // Account age approximated from the 'user-<ms>-...' id timestamp.
            const usersResult = await db.query(`
                SELECT id, name, email, referral_code,
                (EXTRACT(EPOCH FROM (NOW() - TO_TIMESTAMP(CAST(SPLIT_PART(id, '-', 2) AS BIGINT) / 1000.0))) / 86400)::INT as days_since_reg
                FROM users
                WHERE id LIKE 'user-%' AND is_verified = TRUE AND email IS NOT NULL
            `);

            for (const user of usersResult.rows) {
                const dueTips = tips.filter(t => t.sendDay === user.days_since_reg);
                for (const tip of dueTips) {
                    // Skip if this tip was already sent to this user.
                    const logResult = await db.query(
                        'SELECT id FROM periodic_notification_logs WHERE user_id = $1 AND notification_type = $2',
                        [user.id, tip.key],
                    );
                    if (logResult.rowCount && logResult.rowCount > 0) continue;

                    const sent = await sendTemplatedEmail(tip.key, user.email, {
                        userName: user.name || 'there',
                        referralCode: user.referral_code || 'N/A',
                    });

                    if (sent) {
                        await db.query(
                            'INSERT INTO periodic_notification_logs (id, user_id, notification_type) VALUES ($1, $2, $3)',
                            [generateId('notlog'), user.id, tip.key],
                        );
                        console.log(`[scheduler] Sent ${tip.key} to ${user.email}`);
                    }
                }
            }
        } catch (error) {
            console.error('[scheduler] Error in periodic tips job:', error);
        }
    },
};
