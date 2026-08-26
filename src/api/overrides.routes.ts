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
 * tried.
 *
 * Counted per store rather than per address. The PIN space belongs to the
 * store, so that is what has to be defended: an attacker spreading guesses
 * across machines still spends one budget, and a shop running several tills
 * behind one router does not lock itself out by being busy.
 */
const guessAttempts = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: any) => String(req.tenant?.storeId ?? req.user?.id ?? req.ip),
    message: { message: 'Too many PIN attempts. Wait a minute and try again.' },
});

/**
 * Setting your own PIN is not a way in — it already costs the account
 * password — so it gets its own, per-person budget. Sharing one with the
 * guessing endpoint meant a manager changing their PIN could be locked out by
 * a busy afternoon at the tills, or worse, could exhaust the budget that is
 * supposed to be protecting against guesses.
 */
const pinChanges = rateLimit({
    windowMs: 60 * 1000,
    limit: 8,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req: any) => String(req.user?.id ?? req.ip),
    message: { message: 'Too many attempts. Wait a minute and try again.' },
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
    .post(guessAttempts, authorizeOverride);

/**
 * @openapi
 * /overrides/pin:
 *   put:
 *     tags: [Overrides]
 *     summary: Set or clear your own approval PIN (confirms your password)
 *     security:
 *       - bearerAuth: []
 */
router.put('/pin', pinChanges, setManagerPin);

export default router;
