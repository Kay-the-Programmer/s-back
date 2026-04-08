import db from '../db_client';
import { generateId } from '../utils/helpers';
import { invalidateUserCache } from '../middleware/auth.middleware';

export const referralService = {
    /**
     * Generates a random 6-character referral code.
     */
    generateReferralCode: (): string => {
        return Math.random().toString(36).substring(2, 8).toUpperCase();
    },

    /**
     * Links a new user to a referrer based on a referral code.
     */
    processReferral: async (referredUserId: string, referralCode: string) => {
        try {
            const referrerResult = await db.query('SELECT id FROM users WHERE referral_code = $1', [referralCode.toUpperCase()]);
            if (referrerResult.rowCount && referrerResult.rowCount > 0) {
                const referrerId = referrerResult.rows[0].id;
                await db.query('UPDATE users SET referred_by = $1 WHERE id = $2', [referrerId, referredUserId]);
                console.log(`User ${referredUserId} referred by ${referrerId}`);
                return referrerId;
            }
        } catch (error) {
            console.error('Error processing referral:', error);
        }
        return null;
    },

    /**
     * Rewards the referrer when the referred user completes a milestone (e.g., verification).
     */
    rewardReferrer: async (referredUserId: string) => {
        try {
            const userResult = await db.query('SELECT referred_by FROM users WHERE id = $1', [referredUserId]);
            if (!userResult.rowCount || userResult.rowCount === 0 || !userResult.rows[0].referred_by) {
                return;
            }

            const referrerId = userResult.rows[0].referred_by;

            // Check if reward already exists to avoid duplicates
            const existingReward = await db.query(
                'SELECT id FROM referral_rewards WHERE referred_user_id = $1',
                [referredUserId]
            );
            if (existingReward.rowCount && existingReward.rowCount > 0) {
                return;
            }

            // Create reward record
            const rewardId = generateId('refrew');
            const rewardValue = 20.00; // ZMW 20 discount

            await db.query(
                'INSERT INTO referral_rewards (id, referrer_id, referred_user_id, reward_value) VALUES ($1, $2, $3, $4)',
                [rewardId, referrerId, referredUserId, rewardValue]
            );

            // Add to store's discount balance
            // Find the referrer's primary store
            const storeResult = await db.query('SELECT id FROM stores WHERE owner_id = $1 OR id = (SELECT current_store_id FROM users WHERE id = $1)', [referrerId]);
            if (storeResult.rowCount && storeResult.rowCount > 0) {
                const storeId = storeResult.rows[0].id;
                await db.query('UPDATE stores SET discount_balance = discount_balance + $1 WHERE id = $2', [rewardValue, storeId]);
                console.log(`Rewarded store ${storeId} with ${rewardValue} discount for referral of ${referredUserId}`);
            }

            invalidateUserCache(referrerId);
        } catch (error) {
            console.error('Error rewarding referrer:', error);
        }
    }
};
