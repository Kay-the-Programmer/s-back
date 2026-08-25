/**
 * When a cashier must fetch a manager.
 *
 * Pure and free of any database import, so the rule that decides whether a sale
 * is allowed through can be tested on its own. Getting it wrong in either
 * direction is costly: too strict and a queue forms behind every small
 * discount, too loose and the control is decorative.
 */

/** Things a manager can be asked to allow. */
export type OverrideAction = 'discount' | 'refund' | 'pay_out' | 'no_sale';

export const OVERRIDE_ACTIONS: OverrideAction[] = ['discount', 'refund', 'pay_out', 'no_sale'];

export const isOverrideAction = (v: unknown): v is OverrideAction =>
    typeof v === 'string' && (OVERRIDE_ACTIONS as string[]).includes(v);

/**
 * Per-store limits. A missing or null entry means that action never needs a
 * manager — which is how every store behaved before overrides existed, so an
 * upgrade changes nothing until someone sets a limit.
 */
export interface OverrideThresholds {
    /** Discount as a percentage of the basket, e.g. 10 for "10% and above". */
    discountPercent?: number | null;
    /** Refund value at or above which a manager is needed. */
    refundAmount?: number | null;
    /** Cash taken out of the drawer at or above which a manager is needed. */
    payOutAmount?: number | null;
    /** Opening the drawer with no sale always needs one, when enabled. */
    noSale?: boolean | null;
}

const num = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = typeof v === 'number' ? v : parseFloat(String(v));
    return Number.isFinite(n) && n >= 0 ? n : null;
};

/** Read thresholds off a settings row, ignoring anything malformed. */
export const parseThresholds = (raw: unknown): OverrideThresholds => {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return {
        discountPercent: num(o.discountPercent),
        refundAmount: num(o.refundAmount),
        payOutAmount: num(o.payOutAmount),
        noSale: o.noSale === true,
    };
};

/**
 * Whether this action, at this size, needs a manager.
 *
 * The comparison is "at or above", so a limit of 10% means a 10% discount is
 * already the manager's decision. A limit someone sets expecting it to bite at
 * exactly that number should bite there.
 */
export const requiresOverride = (
    action: OverrideAction,
    amount: number,
    thresholds: OverrideThresholds,
): boolean => {
    const value = num(amount) ?? 0;
    switch (action) {
        case 'discount': {
            const limit = thresholds.discountPercent;
            return limit !== null && limit !== undefined && value >= limit;
        }
        case 'refund': {
            const limit = thresholds.refundAmount;
            return limit !== null && limit !== undefined && value >= limit;
        }
        case 'pay_out': {
            const limit = thresholds.payOutAmount;
            return limit !== null && limit !== undefined && value >= limit;
        }
        case 'no_sale':
            return thresholds.noSale === true;
    }
};

/**
 * What a discount is worth as a percentage of the basket.
 *
 * Percentage rather than cash, because a K50 discount is trivial on a K5,000
 * basket and most of the value of a K60 one. A limit expressed in money would
 * either wave through the second or block the first.
 */
export const discountPercentOf = (discount: number, subtotal: number): number => {
    const d = num(discount) ?? 0;
    const s = num(subtotal) ?? 0;
    if (s <= 0) return d > 0 ? 100 : 0;
    return Math.round(((d / s) * 100 + Number.EPSILON) * 100) / 100;
};

/** How long an authorisation stays good for. */
export const OVERRIDE_TTL_SECONDS = 180;

/** The shortest PIN that may be set. */
export const MIN_PIN_LENGTH = 6;

/**
 * A PIN is only ever compared against every manager in the store, so a short
 * one is guessable in a way a password is not. Six digits and digits only —
 * predictable to type at a counter, and long enough that rate limiting can
 * carry the rest.
 */
export const isValidPin = (pin: unknown): boolean =>
    typeof pin === 'string' && /^[0-9]{6,12}$/.test(pin);
