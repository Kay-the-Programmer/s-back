/**
 * The reorder rule — when a product is "low", and how much to buy.
 *
 * Mirrored exactly in the web client (components/purchase-orders/poModel.ts)
 * so the low-stock alert, the Procurement badge and the suggested orders all
 * agree. They used to disagree: the alert fell back to the store's default
 * threshold, but suggestions only counted products with their own reorder
 * point AND a supplier, so most shops were told "low stock" by one screen and
 * "nothing to reorder" by the next.
 */

/** Used when neither the product nor the store sets a threshold. */
export const FALLBACK_THRESHOLD = 5;

/** The product's own reorder point, else the store's low-stock threshold, else 5. */
export const thresholdFor = (reorderPoint: unknown, storeThreshold: unknown): number => {
    const rp = Number(reorderPoint) || 0;
    if (rp > 0) return rp;
    const st = Number(storeThreshold) || 0;
    return st > 0 ? st : FALLBACK_THRESHOLD;
};

export interface ReorderInput {
    stock: unknown;
    reorderPoint: unknown;
    safetyStock?: unknown;
    unitsPerCarton?: unknown;
    unitOfMeasure?: string | null;
}

/** At or below its threshold. */
export const isLow = (p: ReorderInput, storeThreshold: unknown): boolean =>
    (Number(p.stock) || 0) <= thresholdFor(p.reorderPoint, storeThreshold);

/**
 * How much to buy: enough to reach twice the threshold (or threshold plus
 * safety stock, if that is more). Topping up only to the threshold left the
 * product "low" again after its very next sale.
 *
 * Whole units are rounded up to full cartons when the product has a carton
 * size, because that is how suppliers sell them. Weighed goods keep two
 * decimals. Never less than one.
 */
export const reorderQuantity = (p: ReorderInput, storeThreshold: unknown): number => {
    const threshold = thresholdFor(p.reorderPoint, storeThreshold);
    const target = Math.max(threshold * 2, threshold + (Number(p.safetyStock) || 0));
    const need = target - (Number(p.stock) || 0);
    const isKg = p.unitOfMeasure === 'kg';

    if (isKg) return Math.max(0.01, Math.ceil(need * 100) / 100);

    let qty = Math.max(1, Math.ceil(need));
    const carton = Math.floor(Number(p.unitsPerCarton) || 0);
    if (carton > 1) qty = Math.ceil(qty / carton) * carton;
    return qty;
};
