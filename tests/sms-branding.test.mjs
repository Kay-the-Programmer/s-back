/**
 * Can the customer tell who texted them?
 *
 * Every store on the platform shares one Africa's Talking account, so a text
 * leaves here looking anonymous unless something puts the shop's name on it.
 * Two things can: a name prepended to the body, or an alphanumeric sender id
 * the store has registered with the networks. Both have sharp edges this suite
 * guards:
 *
 *   - the prefix must not double when the name is already in the text;
 *   - the characters it costs are real money, so the segment maths has to be
 *     right at 160/153 and at 70/67, not "about 160";
 *   - a store must not be able to grant itself a sender id, because nothing in
 *     the string stops it typing a bank's name into the box;
 *   - and for a store that IS approved, the id has to actually reach the
 *     provider call, or the whole feature is decoration.
 *
 * No server, no database, no credit spent: the provider call is stubbed.
 *
 * Usage:
 *   npm run build && node tests/sms-branding.test.mjs
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
    applyDisplayName,
    displayNamePrefix,
    resolveOutboundSms,
    resolveSenderIdRequest,
    sanitizeDisplayName,
    sanitizeSenderId,
    smsSegments,
    SMS_DISPLAY_NAME_MAX,
} from '../dist/services/sms-branding.js';

const require = createRequire(import.meta.url);

let failed = 0;
const test = (name, fn) => {
    try {
        const r = fn();
        if (r instanceof Promise) return r.then(
            () => console.log(`  ok  ${name}`),
            (err) => { failed++; console.error(`  FAIL  ${name}\n        ${err.message}`); },
        );
        console.log(`  ok  ${name}`);
    } catch (err) {
        failed++;
        console.error(`  FAIL  ${name}`);
        console.error(`        ${err.message}`);
    }
    return undefined;
};

const run = async () => {

// ---------------------------------------------------------------- the prefix

console.log('\napplyDisplayName');

test('an unbranded message gets the store name in front of it', () => {
    assert.equal(
        applyDisplayName('Kay Hardware', 'Your order is ready for collection.'),
        'Kay Hardware: Your order is ready for collection.',
    );
});

test('a message that already opens with the prefix is left alone', () => {
    // The whole point of prepending server-side is that nobody has to remember
    // to do it — which means some messages arrive already carrying it: a saved
    // template, a cashier typing out of habit, or a re-send read back out of
    // the outreach log. Any of those doubling would be worse than no prefix.
    const once = applyDisplayName('Kay Hardware', 'Kay Hardware: Your order is ready.');
    assert.equal(once, 'Kay Hardware: Your order is ready.');
    assert.equal(applyDisplayName('Kay Hardware', once), once);
    assert.equal(applyDisplayName('Kay Hardware', applyDisplayName('Kay Hardware', once)), once);
});

test('the no-double check ignores case and a missing colon', () => {
    assert.equal(applyDisplayName('Kay Hardware', 'kay hardware: hi'), 'kay hardware: hi');
    assert.equal(applyDisplayName('Kay Hardware', 'Kay Hardware - hi'), 'Kay Hardware - hi');
    assert.equal(applyDisplayName('Kay Hardware', 'Kay Hardware'), 'Kay Hardware');
});

test('a name that merely appears in the text is still prefixed', () => {
    // "Kay" in the middle of a sentence is not branding the recipient can rely
    // on; only the opening of the message identifies the sender.
    assert.equal(
        applyDisplayName('Kay', 'Thanks for shopping at Kay today'),
        'Kay: Thanks for shopping at Kay today',
    );
});

test('a store with no name set sends the message unchanged', () => {
    assert.equal(applyDisplayName('', 'Your order is ready.'), 'Your order is ready.');
    assert.equal(applyDisplayName('   ', 'Your order is ready.'), 'Your order is ready.');
});

console.log('\nsanitizeDisplayName');

test('newlines and control characters are stripped, not stored', () => {
    // A name carrying a newline would break the body into what looks like two
    // messages on the handset.
    assert.equal(sanitizeDisplayName('Kay\nHardware'), 'Kay Hardware');
    assert.equal(sanitizeDisplayName('Kay\r\n\tHardware\u0000'), 'Kay Hardware');
});

test('the name is capped so the prefix cannot eat the message', () => {
    const long = sanitizeDisplayName('A'.repeat(80));
    assert.equal(long.length, SMS_DISPLAY_NAME_MAX);
    assert.equal(displayNamePrefix('A'.repeat(80)).length, SMS_DISPLAY_NAME_MAX + 2);
});

// -------------------------------------------------------- what it costs

console.log('\nsmsSegments');

test('160 GSM-7 characters is one message, 161 is two', () => {
    // The whole reason the composer shows this: crossing 160 by one character
    // does not cost a little more, it costs double.
    const at160 = smsSegments('a'.repeat(160));
    assert.equal(at160.segments, 1);
    assert.equal(at160.remaining, 0);
    assert.equal(at160.limit, 160);

    const at161 = smsSegments('a'.repeat(161));
    assert.equal(at161.segments, 2);
    assert.equal(at161.perSegment, 153);
    // Two concatenated parts carry 306, not 320: each loses 7 to the header.
    assert.equal(at161.limit, 306);
    assert.equal(at161.remaining, 306 - 161);
});

test('concatenated parts are 153 each, so 306 and 307 differ by a whole message', () => {
    assert.equal(smsSegments('a'.repeat(306)).segments, 2);
    assert.equal(smsSegments('a'.repeat(307)).segments, 3);
    assert.equal(smsSegments('a'.repeat(153)).segments, 1); // still fits a single 160
});

test('one curly quote halves the allowance', () => {
    // A message pasted out of Word is the common case here. 160 plain letters
    // fit; the same 160 with a single typographic apostrophe is two messages at
    // 70/67, which is why the composer cannot assume 160.
    const unicode = smsSegments('a'.repeat(159) + '’');
    assert.equal(unicode.encoding, 'UCS-2');
    assert.equal(unicode.segments, 3);

    const at70 = smsSegments('a'.repeat(69) + '’');
    assert.equal(at70.encoding, 'UCS-2');
    assert.equal(at70.characters, 70);
    assert.equal(at70.segments, 1);
    assert.equal(at70.remaining, 0);

    const at71 = smsSegments('a'.repeat(70) + '’');
    assert.equal(at71.characters, 71);
    assert.equal(at71.segments, 2);
    assert.equal(at71.perSegment, 67);
    assert.equal(at71.limit, 134);
});

test('an emoji costs two units, and the one before it decides the boundary', () => {
    // 🎂 is outside the BMP: two UTF-16 units, which is what the network bills.
    const cake = smsSegments('\u{1F382}');
    assert.equal(cake.encoding, 'UCS-2');
    assert.equal(cake.characters, 2);
    assert.equal(cake.segments, 1);

    assert.equal(smsSegments('a'.repeat(68) + '\u{1F382}').characters, 70);
    assert.equal(smsSegments('a'.repeat(68) + '\u{1F382}').segments, 1);
    assert.equal(smsSegments('a'.repeat(69) + '\u{1F382}').segments, 2);
});

test('GSM-7 extension characters count double without leaving GSM-7', () => {
    // [ ] { } ~ \ ^ | € are sent as an escape plus a code.
    const brackets = smsSegments('['.repeat(80));
    assert.equal(brackets.encoding, 'GSM-7');
    assert.equal(brackets.characters, 160);
    assert.equal(brackets.segments, 1);
    assert.equal(smsSegments('['.repeat(81)).segments, 2);
});

test('an empty message is zero segments, not one', () => {
    assert.equal(smsSegments('').segments, 0);
    assert.equal(smsSegments('').remaining, 160);
});

test('the count the composer shows includes the prefix', () => {
    // The characters the prefix costs are charged whether or not whoever is
    // typing can see them, so the figure has to be measured on the final text.
    const out = resolveOutboundSms({ displayName: 'Kay Hardware' }, 'a'.repeat(150));
    assert.equal(out.text.length, 164);
    assert.equal(out.segments.segments, 2);
    // Measured on the body alone it would have looked like one message.
    assert.equal(smsSegments('a'.repeat(150)).segments, 1);
});

// ------------------------------------------------- who the message is from

console.log('\nresolveOutboundSms');

test('without an approved sender id the body is prefixed and the platform sends', () => {
    const out = resolveOutboundSms(
        { displayName: 'Kay Hardware', senderId: null, senderIdStatus: 'none' },
        'Your order is ready.',
    );
    assert.equal(out.text, 'Kay Hardware: Your order is ready.');
    assert.equal(out.from, undefined);
    assert.equal(out.prefix, 'Kay Hardware: ');
});

test('a pending sender id is not used — it would be rewritten by the operator', () => {
    const out = resolveOutboundSms(
        { displayName: 'Kay Hardware', senderId: 'KAYHW', senderIdStatus: 'pending' },
        'Your order is ready.',
    );
    assert.equal(out.from, undefined);
    assert.equal(out.text, 'Kay Hardware: Your order is ready.');
});

test('an approved sender id replaces the prefix instead of adding to it', () => {
    // The handset already shows "KAYHW". Spending 14 more characters repeating
    // it is money for nothing.
    const out = resolveOutboundSms(
        { displayName: 'Kay Hardware', senderId: 'KAYHW', senderIdStatus: 'approved' },
        'Your order is ready.',
    );
    assert.equal(out.from, 'KAYHW');
    assert.equal(out.text, 'Your order is ready.');
    assert.equal(out.prefix, '');
});

test('the prefix recorded for the log is empty when nothing was prepended', () => {
    const already = resolveOutboundSms({ displayName: 'Kay Hardware' }, 'Kay Hardware: Hi');
    assert.equal(already.prefix, '');
    assert.equal(already.text, 'Kay Hardware: Hi');
});

// ------------------------------------------- a store cannot approve itself

console.log('\nresolveSenderIdRequest');

test('a store asking for a sender id only ever gets a pending request', () => {
    // The security property of the whole of phase 2: nothing a store sends can
    // put a value in the column the provider call reads.
    const d = resolveSenderIdRequest({ requested: 'BIGBANK', isSuperAdmin: false });
    assert.equal(d.status, 'pending');
    assert.equal(d.requestedSenderId, 'BIGBANK');
    assert.equal(d.senderId, null, 'a store must not be able to set the approved sender id');
    assert.equal(d.changed, true);

    // And the resolver that decides the outgoing `from` ignores it.
    const out = resolveOutboundSms(
        { displayName: 'Kay Hardware', senderId: d.requestedSenderId, senderIdStatus: d.status },
        'hi',
    );
    assert.equal(out.from, undefined);
});

test('a store cannot overwrite an approval it already has', () => {
    const d = resolveSenderIdRequest({
        currentSenderId: 'KAYHW',
        currentStatus: 'approved',
        requested: 'BIGBANK',
        isSuperAdmin: false,
    });
    assert.equal(d.senderId, 'KAYHW');
    assert.equal(d.requestedSenderId, 'BIGBANK');
    assert.equal(d.status, 'pending');
});

test('a store can withdraw its own request but not its approval', () => {
    const withdrawn = resolveSenderIdRequest({
        currentSenderId: 'KAYHW', currentStatus: 'approved', currentRequested: 'KAYSHOP',
        requested: '', isSuperAdmin: false,
    });
    assert.equal(withdrawn.requestedSenderId, null);
    assert.equal(withdrawn.senderId, 'KAYHW');
    assert.equal(withdrawn.status, 'approved');
});

test('only the superadmin path writes the approved column', () => {
    const d = resolveSenderIdRequest({ currentRequested: 'KAYHW', currentStatus: 'pending', requested: 'KAYHW', isSuperAdmin: true });
    assert.equal(d.senderId, 'KAYHW');
    assert.equal(d.requestedSenderId, null);
    assert.equal(d.status, 'approved');
});

test('a superadmin clearing it revokes the approval entirely', () => {
    const d = resolveSenderIdRequest({ currentSenderId: 'KAYHW', currentStatus: 'approved', requested: '', isSuperAdmin: true });
    assert.equal(d.senderId, null);
    assert.equal(d.status, 'none');
    assert.equal(d.changed, true);
});

test('a save that does not mention the sender id changes nothing', () => {
    const d = resolveSenderIdRequest({ currentSenderId: 'KAYHW', currentStatus: 'approved' });
    assert.equal(d.changed, false);
    assert.equal(d.senderId, 'KAYHW');
});

test('a re-asked request is not re-opened', () => {
    const d = resolveSenderIdRequest({ currentRequested: 'KAYHW', currentStatus: 'pending', requested: 'KAYHW', isSuperAdmin: false });
    assert.equal(d.changed, false);
});

test('a requested id is cleaned to what the networks will take', () => {
    assert.equal(sanitizeSenderId('Kay Hardware & Co!'), 'Kay Hardwar');
    assert.equal(sanitizeSenderId('KAY\nHW'), 'KAYHW');
    assert.equal(sanitizeSenderId('A'.repeat(40)).length, 11);
});

// --------------------------------- and it reaches the provider for real

console.log('\nAfricasTalkingService.sendSms');

// Stub the HTTP call. Nothing here should spend an SMS credit, and what we
// care about is the body that would have gone over the wire.
const axios = require('axios');
const realPost = axios.post;
const calls = [];
axios.post = async (url, body) => {
    calls.push({ url, params: new URLSearchParams(body) });
    return { data: { SMSMessageData: { Message: 'Sent to 1/1', Recipients: [{ number: '+260977000111', status: 'Success', statusCode: 101, messageId: 'stub-1', cost: 'ZMW 0.0000' }] } } };
};
process.env.AT_API_KEY = 'stub-key';
process.env.AT_USERNAME = 'sandbox';
delete process.env.AT_SENDER_ID;

const { smsService } = require('../dist/services/sms.service.js');

await test('an approved store\'s sender id is what the provider is asked to send from', async () => {
    calls.length = 0;
    const branding = { displayName: 'Kay Hardware', senderId: 'KAYHW', senderIdStatus: 'approved' };
    const outbound = resolveOutboundSms(branding, 'Your order is ready.');
    await smsService.sendSms('0977000111', outbound.text, outbound.from);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.get('from'), 'KAYHW', 'the approved sender id must reach the provider call');
    assert.equal(calls[0].params.get('message'), 'Your order is ready.');
    assert.equal(calls[0].params.get('to'), '+260977000111');
});

await test('an unapproved store sends under the platform id, with the name in the body', async () => {
    calls.length = 0;
    const outbound = resolveOutboundSms({ displayName: 'Kay Hardware', senderIdStatus: 'pending', senderId: 'KAYHW' }, 'Your order is ready.');
    await smsService.sendSms('0977000111', outbound.text, outbound.from);

    assert.equal(calls[0].params.get('from'), null, 'a pending sender id must not be sent to the provider');
    assert.equal(calls[0].params.get('message'), 'Kay Hardware: Your order is ready.');
});

axios.post = realPost;

console.log(failed === 0 ? '\nAll checks passed.\n' : `\n${failed} check(s) failed.\n`);
if (failed > 0) process.exitCode = 1;

};

run();
