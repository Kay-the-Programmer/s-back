/**
 * The API's temporal contract.
 *
 * Every wrong clock in the product traced back to one helper: `toCamelCase`
 * rewrote timestamps as `"Aug 11, 2026, 11:24:50 AM"` — the server's locale,
 * with no timezone on it. A client then read that UTC instant as local time, so
 * in Zambia (UTC+2) a sale rung up seconds ago displayed as two hours old.
 * Dart could not parse it at all, so the desktop till showed no date.
 *
 * These pin the contract: instants go out as ISO 8601 UTC, calendar days go out
 * as `YYYY-MM-DD`, and neither is ever a human-readable string.
 *
 * Run: node tests/timestamps.test.mjs   (after `npm run build`)
 */
import assert from 'node:assert/strict';
import { toCamelCase, toIsoInstant } from '../dist/utils/helpers.js';

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

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

console.log('toIsoInstant');

test('turns a Date into an unambiguous UTC instant', () => {
    const d = new Date('2026-08-11T09:11:37.758Z');
    assert.equal(toIsoInstant(d), '2026-08-11T09:11:37.758Z');
});

test('keeps a calendar day as a calendar day', () => {
    // A due date is the 11th everywhere. Giving it a time is what makes it
    // land on the 10th for anyone behind the server.
    assert.equal(toIsoInstant('2026-08-11'), '2026-08-11');
});

test('normalises an offset timestamp to UTC rather than trusting it', () => {
    assert.equal(toIsoInstant('2026-08-11T11:11:37.758+02:00'), '2026-08-11T09:11:37.758Z');
});

test('hands back nonsense unchanged instead of inventing a date', () => {
    assert.equal(toIsoInstant('not a date'), 'not a date');
});

console.log('toCamelCase');

test('emits ISO for a sale timestamp, not a human string', () => {
    const out = toCamelCase({ transaction_id: 's1', timestamp: new Date('2026-08-11T09:11:37.758Z') });
    assert.equal(out.transactionId, 's1');
    assert.match(out.timestamp, ISO);
    // The exact bug: a locale string with no zone on it.
    assert.ok(!/AM|PM/.test(out.timestamp), `still human-formatted: ${out.timestamp}`);
});

test('what a client computes from it is the real elapsed time', () => {
    // The reported symptom, reproduced as arithmetic: a sale made "now" must
    // not read as hours old once a client parses it.
    const now = new Date();
    const out = toCamelCase({ timestamp: now });
    const drift = Math.abs(new Date(out.timestamp).getTime() - now.getTime());
    assert.ok(drift < 1000, `client would be off by ${drift}ms`);
});

test('survives a round trip through JSON, which is how it actually travels', () => {
    const out = JSON.parse(JSON.stringify(toCamelCase({ timestamp: new Date('2026-08-11T09:11:37.758Z') })));
    assert.equal(new Date(out.timestamp).toISOString(), '2026-08-11T09:11:37.758Z');
});

test('leaves a DATE column as a plain day', () => {
    // The 1082 type parser hands these over as strings; they must stay that way.
    const out = toCamelCase({ due_date: '2026-08-11', issue_date: '2026-01-05' });
    assert.equal(out.dueDate, '2026-08-11');
    assert.equal(out.issueDate, '2026-01-05');
});

test('covers every temporal field name, not just the obvious one', () => {
    const out = toCamelCase({
        created_at: new Date('2026-08-11T09:00:00.000Z'),
        updated_at: new Date('2026-08-11T09:00:00.000Z'),
        ordered_at: new Date('2026-08-11T09:00:00.000Z'),
        received_at: new Date('2026-08-11T09:00:00.000Z'),
        start_time: new Date('2026-08-11T09:00:00.000Z'),
        end_time: new Date('2026-08-11T09:00:00.000Z'),
    });
    for (const [key, value] of Object.entries(out)) {
        assert.match(value, ISO, `${key} is not ISO: ${value}`);
    }
});

test('reaches timestamps nested in rows and arrays', () => {
    const out = toCamelCase({
        items: [{ transaction_id: 's1', timestamp: new Date('2026-08-11T09:00:00.000Z') }],
        meta: { created_at: new Date('2026-08-11T09:00:00.000Z') },
    });
    assert.match(out.items[0].timestamp, ISO);
    assert.match(out.meta.createdAt, ISO);
});

test('does not maul a Lenco key that merely looks date-ish', () => {
    const out = toCamelCase({ lenco_public_key: 'pub-2026-08-11-abc' });
    assert.equal(out.lencoPublicKey, 'pub-2026-08-11-abc');
});

test('parses as a real instant in Dart-compatible form', () => {
    // The desktop till uses DateTime.parse, which accepts ISO 8601 and nothing
    // else. This is the shape it needs.
    const out = toCamelCase({ timestamp: new Date('2026-08-11T09:11:37.758Z') });
    assert.match(out.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
});

console.log(`\n${passed} passed`);
