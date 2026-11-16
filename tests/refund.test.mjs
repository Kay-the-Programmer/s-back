/**
 * The refund engine, tested on its own — no server, no database.
 *
 * Every case is a refund a cashier hands over. The old till sent
 * "price x qty + flat store tax", which over-refunded zero-rated, exempt and
 * tax-inclusive goods; those cases are pinned here.
 *
 * Usage:
 *   npm run build && node tests/refund.test.mjs
 */
import assert from 'node:assert/strict';
import { computeRefund, pricesIncludedTax } from '../dist/services/refund.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};
const line = (productId, price, quantity, taxClass = 'standard', returned = 0) => ({ productId, price, quantity, returned, taxClass });
const std16 = [{ taxClass: 'standard', ratePct: 16 }];

console.log('mixed tax classes (prices exclusive, 16%)');
// Bread 100 standard (+16), Maize meal 50 zero-rated: charged 166.
const mixed = [line('bread', 100, 1), line('maize', 50, 1, 'zero')];
const mixedSale = { subtotal: 150, total: 166, taxBreakdown: std16, alreadyRefunded: 0 };
test('a zero-rated item refunds its price, no tax (old till: 58.00)', () =>
    assert.equal(computeRefund(mixed, [{ productId: 'maize', quantity: 1 }], mixedSale, 16).amount, 50));
test('a standard item refunds price + 16%', () =>
    assert.equal(computeRefund(mixed, [{ productId: 'bread', quantity: 1 }], mixedSale, 16).amount, 116));
test('the tax part is only the standard item\'s', () =>
    assert.equal(computeRefund(mixed, [{ productId: 'bread', quantity: 1 }], mixedSale, 16).tax, 16));

console.log('tax-inclusive prices');
// Two items at 116 incl. 16% tax: subtotal stored 200, total 232.
const incl = [line('soap', 116, 2)];
const inclSale = { subtotal: 200, total: 232, taxBreakdown: std16, alreadyRefunded: 0 };
test('inclusive prices are detected from the sale', () => assert.equal(pricesIncludedTax(incl, inclSale, 16), true));
test('returning one refunds the shelf price 116 (old till: 134.56)', () =>
    assert.equal(computeRefund(incl, [{ productId: 'soap', quantity: 1 }], inclSale, 16).amount, 116));

console.log('discounts');
// Two at 100, 20 off (ex-tax), 16%: net 180, tax 28.80, total 208.80.
const disc = [line('a', 100, 1), line('b', 100, 1)];
const discSale = { subtotal: 200, total: 208.8, taxBreakdown: std16, alreadyRefunded: 0 };
test('one of two refunds its share of the discounted total (104.40)', () =>
    assert.equal(computeRefund(disc, [{ productId: 'a', quantity: 1 }], discSale, 16).amount, 104.4));
test('the last return takes exactly what is left', () => {
    const after = [line('a', 100, 1, 'standard', 1), line('b', 100, 1)];
    const r = computeRefund(after, [{ productId: 'b', quantity: 1 }], { ...discSale, alreadyRefunded: 104.4 }, 16);
    assert.equal(r.amount, 104.4);
});
test('rounding never strands a cent: 3 x 33.33 total 100 refunded in full', () => {
    const three = [line('x', 33.33, 3, 'zero')];
    const s = { subtotal: 99.99, total: 100, taxBreakdown: std16, alreadyRefunded: 0 };
    assert.equal(computeRefund(three, [{ productId: 'x', quantity: 3 }], s, 16).amount, 100);
});

console.log('history and extras');
test('the rate on the receipt wins over today\'s setting', () =>
    assert.equal(computeRefund(mixed, [{ productId: 'bread', quantity: 1 }], mixedSale, 0).amount, 116));
test('a delivery fee is not refunded with the goods', () => {
    const s = { subtotal: 150, total: 191, deliveryFee: 25, taxBreakdown: std16, alreadyRefunded: 0 };
    assert.equal(computeRefund(mixed, [{ productId: 'bread', quantity: 1 }, { productId: 'maize', quantity: 1 }], s, 16).amount, 166);
});
test('never more than is left on the sale', () =>
    assert.equal(computeRefund(mixed, [{ productId: 'bread', quantity: 1 }], { ...mixedSale, alreadyRefunded: 100 }, 16).amount, 66));
test('net + tax always equals the refund', () => {
    const r = computeRefund(disc, [{ productId: 'a', quantity: 1 }], discSale, 16);
    assert.equal(Math.round((r.net + r.tax) * 100) / 100, r.amount);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
