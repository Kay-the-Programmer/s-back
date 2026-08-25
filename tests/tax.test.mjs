/**
 * The tax engine, tested on its own.
 *
 * No server, no database. Every assertion here is a receipt a customer could be
 * handed: getting one wrong overcharges a shopper or under-declares to the
 * revenue authority, and neither shows up as an error at the till.
 *
 * Usage:
 *   npm run build && node tests/tax.test.mjs
 */
import assert from 'node:assert/strict';
import { computeTax, rateFor, toTaxClass } from '../dist/services/tax.js';

let passed = 0;
const test = (name, fn) => {
    try {
        fn();
        passed++;
        console.log(`  ok  ${name}`);
    } catch (err) {
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err.message}`);
        process.exitCode = 1;
    }
};

const EXCLUSIVE = { standardRatePct: 16, pricesIncludeTax: false };
const INCLUSIVE = { standardRatePct: 16, pricesIncludeTax: true };
const line = (price, quantity, taxClass = 'standard') => ({ price, quantity, taxClass });

console.log('\ntax classes');

test('standard-rated goods attract the store rate', () => {
    assert.equal(rateFor('standard', 16), 0.16);
});

test('zero-rated and exempt goods attract nothing', () => {
    assert.equal(rateFor('zero', 16), 0);
    assert.equal(rateFor('exempt', 16), 0);
});

test('an unknown class is charged tax rather than silently exempted', () => {
    // Under-collecting is a debt to the revenue authority discovered at audit;
    // over-collecting is a complaint at the counter the same day.
    assert.equal(toTaxClass(undefined), 'standard');
    assert.equal(toTaxClass('nonsense'), 'standard');
});

console.log('\nprices excluding tax');

test('matches the old flat-rate maths when everything is standard-rated', () => {
    // The behaviour this replaces. A single-rate store must see no change.
    const r = computeTax([line(100, 2), line(50, 1)], 0, EXCLUSIVE);
    assert.equal(r.subtotal, 250);
    assert.equal(r.tax, 40);
    assert.equal(r.total, 290);
});

test('charges nothing on a purely zero-rated basket', () => {
    const r = computeTax([line(80, 1, 'zero')], 0, EXCLUSIVE);
    assert.equal(r.subtotal, 80);
    assert.equal(r.tax, 0);
    assert.equal(r.total, 80);
});

test('taxes only the taxable half of a mixed basket', () => {
    // The bug this exists to fix: mealie meal is zero-rated, soap is not, and
    // one rate on the subtotal charged tax on the mealie meal too.
    const r = computeTax([line(200, 1, 'zero'), line(100, 1, 'standard')], 0, EXCLUSIVE);
    assert.equal(r.subtotal, 300);
    assert.equal(r.tax, 16);
    assert.equal(r.total, 316);
});

test('spreads a discount across the basket in proportion', () => {
    // K30 off a 200 zero / 100 standard basket takes 20 off the zero-rated part
    // and 10 off the taxable one, so tax falls to 16% of 90.
    const r = computeTax([line(200, 1, 'zero'), line(100, 1, 'standard')], 30, EXCLUSIVE);
    assert.equal(r.subtotal, 300);
    assert.equal(r.discount, 30);
    assert.equal(r.tax, 14.4);
    assert.equal(r.total, 284.4);
});

console.log('\nprices including tax');

test('extracts tax from the price rather than adding to it', () => {
    // A shelf price of K116 at 16% is K100 of goods and K16 of tax. The
    // customer pays the marked price — that is the whole point of the mode.
    const r = computeTax([line(116, 1)], 0, INCLUSIVE);
    assert.equal(r.subtotal, 100);
    assert.equal(r.tax, 16);
    assert.equal(r.total, 116);
});

test('leaves a zero-rated inclusive price untouched', () => {
    const r = computeTax([line(116, 1, 'zero')], 0, INCLUSIVE);
    assert.equal(r.subtotal, 116);
    assert.equal(r.tax, 0);
    assert.equal(r.total, 116);
});

test('a discount off an inclusive price is what the customer sees', () => {
    // "K16 off" on a K116 shelf price must leave the customer paying K100.
    const r = computeTax([line(116, 1)], 16, INCLUSIVE);
    assert.equal(r.total, 100);
    assert.equal(r.discountAsEntered, 16);
    // And the tax falls with it, rather than being charged on the full price.
    assert.ok(r.tax < 16);
});

console.log('\ninvariants that must hold on every sale');

const baskets = [
    { lines: [line(100, 3), line(45.5, 2, 'zero')], discount: 0 },
    { lines: [line(19.99, 7), line(3.33, 11, 'exempt')], discount: 25 },
    { lines: [line(0.05, 3), line(1234.56, 1)], discount: 1000 },
    { lines: [line(12.5, 2, 'zero'), line(12.5, 2, 'standard'), line(12.5, 2, 'exempt')], discount: 7.77 },
];

for (const config of [EXCLUSIVE, INCLUSIVE]) {
    const mode = config.pricesIncludeTax ? 'inclusive' : 'exclusive';
    baskets.forEach((b, i) => {
        test(`${mode} basket ${i + 1}: total equals subtotal − discount + tax`, () => {
            // Every downstream consumer — the sales row, the ledger, the
            // dashboard — assumes this identity. If it drifts by a cent the
            // journal entry does not balance and the sale is rejected.
            const r = computeTax(b.lines, b.discount, config);
            assert.equal(r.total, Number((r.subtotal - r.discount + r.tax).toFixed(2)));
        });

        test(`${mode} basket ${i + 1}: the printed breakdown adds up to the printed tax`, () => {
            // A VAT invoice shows tax per class. If those do not sum to the tax
            // charged, the invoice is not a valid one.
            const r = computeTax(b.lines, b.discount, config);
            const summed = Number(r.byClass.reduce((a, c) => a + c.tax, 0).toFixed(2));
            assert.equal(summed, r.tax);
            const nets = Number(r.byClass.reduce((a, c) => a + c.net, 0).toFixed(2));
            assert.equal(nets, Number((r.subtotal - r.discount).toFixed(2)));
        });

        test(`${mode} basket ${i + 1}: no negative money anywhere`, () => {
            const r = computeTax(b.lines, b.discount, config);
            for (const [k, v] of Object.entries(r)) {
                if (typeof v === 'number') assert.ok(v >= 0, `${k} was ${v}`);
            }
        });
    });
}

console.log('\nedges');

test('an empty basket is all zeros, not NaN', () => {
    const r = computeTax([], 0, EXCLUSIVE);
    assert.deepEqual(
        { subtotal: r.subtotal, discount: r.discount, tax: r.tax, total: r.total },
        { subtotal: 0, discount: 0, tax: 0, total: 0 },
    );
});

test('a discount larger than the basket cannot make the total negative', () => {
    const r = computeTax([line(50, 1)], 9999, EXCLUSIVE);
    assert.equal(r.total, 0);
});

test('rubbish in a line does not poison the sale', () => {
    const r = computeTax(
        [{ price: 'abc', quantity: 2, taxClass: 'standard' }, line(100, 1)],
        0,
        EXCLUSIVE,
    );
    assert.equal(r.subtotal, 100);
    assert.equal(r.tax, 16);
});

console.log(`\n${passed} checks passed\n`);
