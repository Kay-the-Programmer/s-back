/**
 * What to give back for returned items, worked out from the sale itself.
 *
 * The till used to send the refund amount, computed as "price x qty + the
 * store's flat tax rate". That added tax to zero-rated and exempt goods, and
 * added it AGAIN on tax-inclusive prices; the server only checked the figure
 * was not more than the sale's remaining balance, so the extra was paid out.
 *
 * Now the server works it out:
 *   1. Price every line of the sale with the tax engine, at the tax class it
 *      was SOLD under and the standard rate printed on the sale's receipt
 *      (tax_breakdown), inclusive or exclusive as the sale's own figures show.
 *   2. Scale those so they add up to what the sale actually charged for goods
 *      (its total less any delivery fee). That shares the discount out exactly,
 *      in whatever form it was given.
 *   3. The refund is the returned quantities' part of that.
 * The last return on a sale takes exactly what is left, so cents of rounding
 * never strand on, or overrun, a sale.
 */
import { computeTax, toTaxClass, TaxClass } from './tax';

export interface SoldLine {
    productId: string;
    price: number;        // price_at_sale, as entered (inclusive or not)
    quantity: number;     // sold
    returned: number;     // already returned before this return
    taxClass: TaxClass | string | null;
}

export interface SaleFigures {
    subtotal: number;     // ex-tax goods value before discount, as stored
    total: number;        // what was charged
    deliveryFee?: number; // part of total that is not goods
    /** Stored tax_breakdown rows; the standard row carries the rate charged. */
    taxBreakdown?: { taxClass: string; ratePct: number }[] | null;
    /** Already refunded on this sale. */
    alreadyRefunded: number;
}

export interface RefundResult {
    amount: number;
    tax: number;
    net: number;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** The standard rate the sale was charged at, else the store's current one. */
export const rateOfSale = (sale: SaleFigures, storeRatePct: number): number => {
    const std = (sale.taxBreakdown || []).find(r => r?.taxClass === 'standard');
    return std ? num(std.ratePct) : num(storeRatePct);
};

/**
 * Prices included tax when the stored subtotal (ex-tax) is visibly below the
 * shelf value of what was sold. Exclusive prices make the two equal.
 */
export const pricesIncludedTax = (lines: SoldLine[], sale: SaleFigures, ratePct: number): boolean => {
    if (ratePct <= 0) return false;
    if (!lines.some(l => toTaxClass(l.taxClass) === 'standard')) return false;
    const gross = lines.reduce((a, l) => a + num(l.price) * num(l.quantity), 0);
    return num(sale.subtotal) < round2(gross) - 0.01;
};

export const computeRefund = (
    lines: SoldLine[],
    returned: { productId: string; quantity: number }[],
    sale: SaleFigures,
    storeRatePct: number,
): RefundResult => {
    const ratePct = rateOfSale(sale, storeRatePct);
    const cfg = { standardRatePct: ratePct, pricesIncludeTax: pricesIncludedTax(lines, sale, ratePct) };

    // Charged-per-unit, tax included, before any discount — for each line.
    const unit = new Map<string, { gross: number; tax: number }>();
    let saleGross = 0;
    for (const l of lines) {
        const one = computeTax([{ price: num(l.price), quantity: 1, taxClass: toTaxClass(l.taxClass) }], 0, cfg);
        unit.set(l.productId, { gross: one.total, tax: one.tax });
        saleGross += one.total * num(l.quantity);
    }

    // Scale to what the goods actually cost the customer (discount included).
    const goodsCharged = Math.max(0, num(sale.total) - num(sale.deliveryFee));
    const k = saleGross > 0 ? goodsCharged / saleGross : 0;

    let amount = 0;
    let tax = 0;
    for (const r of returned) {
        const u = unit.get(r.productId);
        const q = num(r.quantity);
        if (!u || !(q > 0)) continue;
        amount += u.gross * q * k;
        tax += u.tax * q * k;
    }
    amount = round2(amount);
    tax = round2(tax);

    // Taking everything still on the sale: give back exactly what is left.
    const refundable = Math.max(0, round2(num(sale.total) - num(sale.deliveryFee) - num(sale.alreadyRefunded)));
    const takesAll = lines.every(l => {
        const left = num(l.quantity) - num(l.returned);
        const now = returned.filter(r => r.productId === l.productId).reduce((a, r) => a + num(r.quantity), 0);
        return now >= left - 0.0001;
    });
    if (takesAll || amount > refundable) {
        tax = amount > 0 ? round2(tax * (refundable / amount)) : 0;
        amount = refundable;
    }
    return { amount, tax, net: round2(amount - tax) };
};
