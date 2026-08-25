/**
 * What tax is due on a sale, line by line.
 *
 * The old model was one flat rate applied to the whole basket. That cannot be
 * right for a shop selling more than one kind of thing: mealie meal is
 * zero-rated, soap is standard-rated, and a single percentage on the subtotal
 * charges the customer the wrong amount on every mixed basket.
 *
 * Two things vary and both live here:
 *
 *  * **Tax class per product** — standard, zero-rated, or exempt. Zero and
 *    exempt both attract no tax, but they are kept apart because a VAT return
 *    reports them differently: zero-rated supplies are taxable at 0%, exempt
 *    ones are outside the tax entirely.
 *  * **Whether prices already include tax.** Shelf prices in most retail here
 *    are quoted tax-inclusive, in which case tax is *extracted* from the price
 *    rather than added to it.
 *
 * Free of any database import so it can be tested on its own, and mirrored by
 * `utils/tax.ts` in the web till. The two must agree: the client shows the
 * customer a total before the server has seen the sale, and if they disagree
 * the shopper is quoted one figure and charged another.
 */

export type TaxClass = 'standard' | 'zero' | 'exempt';

export const TAX_CLASSES: TaxClass[] = ['standard', 'zero', 'exempt'];

export const isTaxClass = (v: unknown): v is TaxClass =>
    typeof v === 'string' && (TAX_CLASSES as string[]).includes(v);

/** Anything unrecognised is treated as standard-rated — the safe default is to
 *  charge tax and be corrected, not to under-collect silently. */
export const toTaxClass = (v: unknown): TaxClass => (isTaxClass(v) ? v : 'standard');

export interface TaxLine {
    /** Unit price as entered: tax-inclusive or not, per the config. */
    price: number;
    quantity: number;
    taxClass: TaxClass;
}

export interface TaxConfig {
    /** The store's standard rate as a percentage — 16 for 16%. */
    standardRatePct: number;
    /** Prices already contain tax, so it is extracted rather than added. */
    pricesIncludeTax: boolean;
}

export interface TaxClassTotal {
    taxClass: TaxClass;
    ratePct: number;
    /** Ex-tax value of these goods, after discount. */
    net: number;
    tax: number;
}

export interface TaxResult {
    /** Ex-tax value of the goods before discount. The stored `subtotal`. */
    subtotal: number;
    /** Ex-tax value of the discount. The stored `discount`. */
    discount: number;
    tax: number;
    /** subtotal − discount + tax. Excludes store credit, which is settlement. */
    total: number;
    /** The discount as the customer sees it, in the terms prices are quoted in. */
    discountAsEntered: number;
    byClass: TaxClassTotal[];
}

const round2 = (n: number): number =>
    Math.round((toNumber(n) + Number.EPSILON) * 100) / 100;

const toNumber = (v: unknown): number => {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? 0));
    return Number.isFinite(n) ? n : 0;
};

/** The rate a class attracts. Zero and exempt both attract none. */
export const rateFor = (taxClass: TaxClass, standardRatePct: number): number =>
    taxClass === 'standard' ? Math.max(0, toNumber(standardRatePct)) / 100 : 0;

/**
 * Work out the tax on a basket.
 *
 * `discount` is given in whatever terms prices are quoted in — a cashier taking
 * "K100 off" means K100 off what the customer sees. It is spread across the
 * lines in proportion to their value, so a discount on a mixed basket reduces
 * the taxable and the zero-rated parts fairly rather than coming out of one.
 */
export const computeTax = (
    lines: TaxLine[],
    discount: number,
    config: TaxConfig,
): TaxResult => {
    const rows = (lines ?? []).map(l => ({
        taxClass: toTaxClass(l?.taxClass),
        value: Math.max(0, round2(toNumber(l?.price) * toNumber(l?.quantity))),
    }));

    const grossValue = rows.reduce((a, r) => a + r.value, 0);
    // A discount cannot exceed the basket; a negative one is not a discount.
    const entered = Math.min(Math.max(toNumber(discount), 0), round2(grossValue));

    const netBefore = new Map<TaxClass, number>();
    const netAfter = new Map<TaxClass, number>();

    for (const row of rows) {
        const rate = rateFor(row.taxClass, config.standardRatePct);
        const divisor = config.pricesIncludeTax ? 1 + rate : 1;

        // Proportional share of the discount, in the terms prices are quoted in.
        const share = grossValue > 0 ? (entered * row.value) / grossValue : 0;

        add(netBefore, row.taxClass, row.value / divisor);
        add(netAfter, row.taxClass, (row.value - share) / divisor);
    }

    const byClass: TaxClassTotal[] = TAX_CLASSES
        .filter(c => netBefore.has(c))
        .map(c => {
            const ratePct = rateFor(c, config.standardRatePct) * 100;
            const net = round2(netAfter.get(c) ?? 0);
            return { taxClass: c, ratePct, net, tax: round2(net * (ratePct / 100)) };
        });

    // Everything below is derived from the rounded per-class figures rather
    // than recomputed, so the breakdown printed on a receipt adds up to the
    // tax printed beneath it. A VAT inspector checks exactly that.
    const netAfterTotal = round2(byClass.reduce((a, c) => a + c.net, 0));
    const subtotal = round2(sum(netBefore));
    const tax = round2(byClass.reduce((a, c) => a + c.tax, 0));

    return {
        subtotal,
        // Defined as the gap between the two, so `subtotal − discount` is
        // exactly the net that was taxed. Deriving it any other way lets a
        // rounded cent fall between the stored figures and the printed ones.
        discount: round2(subtotal - netAfterTotal),
        tax,
        total: round2(netAfterTotal + tax),
        discountAsEntered: round2(entered),
        byClass,
    };
};

const add = (map: Map<TaxClass, number>, key: TaxClass, value: number): void => {
    map.set(key, (map.get(key) ?? 0) + value);
};

const sum = (map: Map<TaxClass, number>): number => {
    let total = 0;
    for (const v of map.values()) total += v;
    return total;
};
