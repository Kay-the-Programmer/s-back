/**
 * The till arithmetic, tested on its own.
 *
 * No server, no database — `src/services/cash-math.ts` imports neither, so the
 * one part of the cash drawer that must be numerically right can be checked in
 * isolation. Getting it wrong never throws: it tells a shopkeeper their cashier
 * is short, or quietly hides that they are.
 *
 * Usage:
 *   npm run build && node tests/cash-math.test.mjs
 */
import assert from 'node:assert/strict';
import { computeExpectedCash, computeVariance, round2 } from '../dist/services/cash-math.js';

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

const totals = (over = {}) => ({
    openingFloat: 0, cashSales: 0, cashRefunds: 0, payIns: 0, payOuts: 0, ...over,
});

console.log('\ncomputeExpectedCash');

test('a drawer with only its float expects the float back', () => {
    assert.equal(computeExpectedCash(totals({ openingFloat: 500 })), 500);
});

test('cash taken over the counter adds to the drawer', () => {
    assert.equal(computeExpectedCash(totals({ openingFloat: 500, cashSales: 1250.5 })), 1750.5);
});

test('cash refunds come back out of the drawer', () => {
    assert.equal(
        computeExpectedCash(totals({ openingFloat: 500, cashSales: 1000, cashRefunds: 150 })),
        1350,
    );
});

test('pay-ins and pay-outs move the expected total both ways', () => {
    // Paying a delivery driver out of the till, then topping the float back up.
    assert.equal(
        computeExpectedCash(totals({ openingFloat: 500, payIns: 200, payOuts: 80 })),
        620,
    );
});

test('ignores takings that never touch the drawer', () => {
    // Card and mobile money are revenue, but the notes never arrive. Counting
    // them here would report every honest till short by the day's card sales.
    const cashOnly = totals({ openingFloat: 500, cashSales: 300 });
    assert.equal(computeExpectedCash(cashOnly), 800);
    // There is no field for them at all — the shape itself enforces it.
    assert.deepEqual(Object.keys(cashOnly).sort(), [
        'cashRefunds', 'cashSales', 'openingFloat', 'payIns', 'payOuts',
    ]);
});

test('a full shift adds up', () => {
    assert.equal(
        computeExpectedCash(totals({
            openingFloat: 500, cashSales: 4820.75, cashRefunds: 220.25, payIns: 100, payOuts: 350,
        })),
        4850.5,
    );
});

test('survives a missing or unparseable figure rather than returning NaN', () => {
    // An empty table sums to null. A NaN here would render as "expected NaN"
    // on a Z report and make the whole close meaningless.
    assert.equal(computeExpectedCash({ openingFloat: 100, cashSales: null }), 100);
    assert.equal(computeExpectedCash({}), 0);
});

console.log('\ncomputeVariance');

test('a drawer that matches is neither over nor short', () => {
    assert.equal(computeVariance(4850.5, 4850.5), 0);
});

test('reports a shortage as negative and a surplus as positive', () => {
    assert.equal(computeVariance(4800, 4850), -50);
    assert.equal(computeVariance(4900, 4850), 50);
});

test('does not report a matching till as a fraction of a ngwee out', () => {
    // 0.1 + 0.2 is 0.30000000000000004. Unrounded, a till that balances to the
    // cent reports a variance, and the one person who most needs to trust the
    // number stops trusting it.
    const expected = computeExpectedCash(totals({ openingFloat: 0.1, cashSales: 0.2 }));
    assert.equal(computeVariance(0.3, expected), 0);
});

console.log('\nround2');

test('rounds half up, so money does not drift', () => {
    assert.equal(round2(1.005), 1.01);
    assert.equal(round2(2.675), 2.68);
    assert.equal(round2(-1.005), -1);
});

console.log(`\n${passed} checks passed\n`);
