import express from 'express';
import rateLimit from 'express-rate-limit';
import {
    authorizeOverride,
    getOverrideThresholds,
    setManagerPin,
} from '../controllers/overrides.controller';
import { protect } from '../middleware/auth.middleware';

const router = express.Router();

router.use(protect);

/**
 * A PIN is short, and it is checked against every manager in the store, so the
 * only thing standing between six digits and a guess is how fast they can be
 * tried. Ten a minute leaves a real cashier untroubled — a manager typing a PIN
 * twice is normal, twenty times is not.
 */
const pinAttempts = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { message: 'Too many PIN attempts. Wait a minute and try again.' },
});

/**
 * @openapi
 * /overrides:
 *   get:
 *     tags: [Overrides]
 *     summary: What this store asks a manager to approve
 *     security:
 *       - bearerAuth: []
 *   post:
 *     tags: [Overrides]
 *     summary: Approve one action with a manager PIN
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       201:
 *         description: Single-use authorisation granted
 *       403:
 *         description: PIN not recognised
 */
router.route('/')
    .get(getOverrideThresholds)
    .post(pinAttempts, authorizeOverride);

/**
 * @openapi
 * /overrides/pin:
 *   put:
 *     tags: [Overrides]
 *     summary: Set or clear your own approval PIN (confirms your password)
 *     security:
 *       - bearerAuth: []
 */
router.put('/pin', pinAttempts, setManagerPin);

export default router;
