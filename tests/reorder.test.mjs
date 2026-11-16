/**
 * The reorder rule, tested on its own — no server, no database.
 *
 * Usage:
 *   npm run build && node tests/reorder.test.mjs
 */
import assert from 'node:assert/strict';
import { thresholdFor, isLow, reorderQuantity, FALLBACK_THRESHOLD } from '../dist/services/reorder.js';

let passed = 0;
let failed = 0;
const test = (name, fn) => {
    try { fn(); passed++; console.log(`  ok  ${name}`); }
    catch (err) { failed++; console.log(`  FAIL ${name}\n       ${err.message}`); }
};

console.log('threshold');
test('own reorder point wins', () => assert.equal(thresholdFor(8, 3), 8));
test('no reorder point → store threshold', () => assert.equal(thresholdFor(null, 3), 3));
test('zero reorder point counts as unset', () => assert.equal(thresholdFor(0, 3), 3));
test('neither set → fallback', () => assert.equal(thresholdFor(null, null), FALLBACK_THRESHOLD));
test('Postgres numerics as strings', () => assert.equal(thresholdFor('10.000', '4'), 10));

console.log('isLow');
test('at the threshold is low', () => assert.equal(isLow({ stock: 5, reorderPoint: 5 }, 0), true));
test('above the threshold is not', () => assert.equal(isLow({ stock: 6, reorderPoint: 5 }, 0), false));
test('uses store threshold when product has none', () => assert.equal(isLow({ stock: 3, reorderPoint: null }, 4), true));
test('the old rule missed this: no own reorder point, stock 2', () => assert.equal(isLow({ stock: 2, reorderPoint: 0 }, null), true));

console.log('reorderQuantity');
test('tops up to twice the threshold', () => assert.equal(reorderQuantity({ stock: 2, reorderPoint: 5 }, 0), 8));
test('safety stock raises the target when larger', () =>
    assert.equal(reorderQuantity({ stock: 2, reorderPoint: 5, safetyStock: 10 }, 0), 13));
test('out of stock with store threshold', () => assert.equal(reorderQuantity({ stock: 0, reorderPoint: null }, 5), 10));
test('rounds up to whole cartons', () =>
    assert.equal(reorderQuantity({ stock: 2, reorderPoint: 5, unitsPerCarton: 12 }, 0), 12));
test('several cartons', () =>
    assert.equal(reorderQuantity({ stock: 0, reorderPoint: 20, unitsPerCarton: 12 }, 0), 48));
test('carton of 1 changes nothing', () =>
    assert.equal(reorderQuantity({ stock: 2, reorderPoint: 5, unitsPerCarton: 1 }, 0), 8));
test('weighed goods keep two decimals', () =>
    assert.equal(reorderQuantity({ stock: 1.25, reorderPoint: 3, unitOfMeasure: 'kg' }, 0), 4.75));
test('weighed goods ignore cartons', () =>
    assert.equal(reorderQuantity({ stock: 1.25, reorderPoint: 3, unitOfMeasure: 'kg', unitsPerCarton: 10 }, 0), 4.75));
test('never below one unit', () => assert.equal(reorderQuantity({ stock: 50, reorderPoint: 5 }, 0), 1));
test('negative stock still orders enough', () => assert.equal(reorderQuantity({ stock: -3, reorderPoint: 5 }, 0), 13));

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
