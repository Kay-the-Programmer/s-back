/**
 * When a cashier must fetch a manager.
 *
 * No server, no database. This rule sits between a customer waiting at a
 * counter and a control that only works if it is obeyed, and it is wrong in
 * two different ways: too strict and a queue forms behind every small discount,
 * too loose and the approval is decoration.
 *
 * Usage:
 *   npm run build && node tests/override-rules.test.mjs
 */
import assert from 'node:assert/strict';
import {
    discountPercentOf,
    isValidPin,
    parseThresholds,
    requiresOverride,
} from '../dist/services/override-rules.js';

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

console.log('\nrequiresOverride');

test('a store that has set no limits asks for nothing', () => {
    // Every store before this feature existed. Upgrading must not suddenly put
    // a PIN prompt in front of a shop that never asked for one.
    const none = parseThresholds(null);
    assert.equal(requiresOverride('discount', 90, none), false);
    assert.equal(requiresOverride('refund', 100000, none), false);
    assert.equal(requiresOverride('pay_out', 100000, none), false);
    assert.equal(requiresOverride('no_sale', 0, none), false);
});

test('a discount under the limit passes without asking', () => {
    const t = parseThresholds({ discountPercent: 10 });
    assert.equal(requiresOverride('discount', 9.99, t), false);
});

test('the limit itself already needs a manager', () => {
    // Someone setting "10%" means a tenth off is the manager's call. A rule
    // that only bit above 10 would surprise them on the first use.
    const t = parseThresholds({ discountPercent: 10 });
    assert.equal(requiresOverride('discount', 10, t), true);
});

test('refunds and pay-outs are measured in money, not percent', () => {
    const t = parseThresholds({ refundAmount: 500, payOutAmount: 200 });
    assert.equal(requiresOverride('refund', 499.99, t), false);
    assert.equal(requiresOverride('refund', 500, t), true);
    assert.equal(requiresOverride('pay_out', 200, t), true);
});

test('one limit does not switch on the others', () => {
    // A shop that only cares about discounts must not find its refunds gated.
    const t = parseThresholds({ discountPercent: 5 });
    assert.equal(requiresOverride('refund', 999999, t), false);
    assert.equal(requiresOverride('pay_out', 999999, t), false);
});

test('rubbish in the settings row is treated as no limit', () => {
    // Never as a limit of zero, which would demand a manager for every sale
    // and stop the shop trading over a bad column.
    const t = parseThresholds({ discountPercent: 'abc', refundAmount: -5 });
    assert.equal(requiresOverride('discount', 100, t), false);
    assert.equal(requiresOverride('refund', 100, t), false);
});

console.log('\ndiscountPercentOf');

test('measures a discount against the basket it came off', () => {
    // K50 is trivial on K5,000 and most of a K60 basket. A limit in money would
    // wave the first through and block the second.
    assert.equal(discountPercentOf(50, 5000), 1);
    assert.equal(discountPercentOf(50, 60), 83.33);
});

test('a discount on an empty basket is the whole of it', () => {
    assert.equal(discountPercentOf(10, 0), 100);
    assert.equal(discountPercentOf(0, 0), 0);
});

console.log('\nisValidPin');

test('accepts a six-to-twelve digit PIN', () => {
    assert.equal(isValidPin('483920'), true);
    assert.equal(isValidPin('483920114857'), true);
});

test('refuses anything short enough to guess', () => {
    // The PIN is compared against every manager in the store, so a short one is
    // everyone's exposure, not just its owner's.
    assert.equal(isValidPin('1234'), false);
    assert.equal(isValidPin('12345'), false);
});

test('refuses letters, spaces and nothing at all', () => {
    assert.equal(isValidPin('abcdef'), false);
    assert.equal(isValidPin('12 456'), false);
    assert.equal(isValidPin(''), false);
    assert.equal(isValidPin(undefined), false);
    assert.equal(isValidPin(123456), false);
});

console.log(`\n${passed} checks passed\n`);
