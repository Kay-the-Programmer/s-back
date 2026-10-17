/**
 * Who sent this text, and what it costs to say so.
 *
 * Every store on the platform shares one Africa's Talking account, so without
 * help a customer sees an anonymous shortcode and has no way to tell which shop
 * texted them. Two things fix that, and this module holds the rules for both so
 * the controller cannot forget them and the composer can price them before the
 * cashier presses send:
 *
 *   1. A display name prepended server-side ("Kay Hardware: Your order is
 *      ready"). Works everywhere, needs no registration, costs characters.
 *   2. An alphanumeric sender id, which only the mobile networks can grant. A
 *      store that has one needs no prefix — the handset already shows the name.
 *
 * Nothing here touches the database or the network, so the maths below is the
 * same number the composer shows and the server charges.
 */

/** Longest display name we will prepend. Beyond this the prefix eats the message. */
export const SMS_DISPLAY_NAME_MAX = 20;
/** Alphanumeric sender ids are capped at 11 characters by the networks. */
export const SMS_SENDER_ID_MAX = 11;

export type SmsSenderIdStatus = 'none' | 'pending' | 'approved' | 'rejected';

/**
 * Characters the GSM 03.38 basic alphabet can carry in 7 bits. Anything outside
 * this (and the extension table below) forces the whole message to UCS-2, which
 * more than halves what fits — a single curly quote pasted from Word is enough.
 */
const GSM7_BASIC =
    '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

/** GSM-7 extension characters. Each is sent as an escape plus a code: two units. */
const GSM7_EXTENDED = '\f^{}\\[~]|€';

const GSM7_BASIC_SET = new Set(GSM7_BASIC.split(''));
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED.split(''));

export interface SmsSegmentInfo {
    /** How the provider will encode it, which decides the limits below. */
    encoding: 'GSM-7' | 'UCS-2';
    /** Billable units, not JS characters: an extended GSM char counts 2. */
    characters: number;
    /** Units allowed in the current shape (single vs concatenated). */
    limit: number;
    /** Units per part once a message is split. */
    perSegment: number;
    /** Parts the network will actually bill for. */
    segments: number;
    /** Units left before the next part starts. Never negative. */
    remaining: number;
}

/**
 * Count a message the way the network bills it.
 *
 * A single SMS carries 160 GSM-7 units; past that each part loses 7 units to
 * the concatenation header, so parts hold 153. In UCS-2 the same split is
 * 70 and 67. Getting this wrong is not cosmetic — it is the difference between
 * one charge and three.
 */
export const smsSegments = (text: string): SmsSegmentInfo => {
    const value = text || '';
    let gsm7 = true;
    let units = 0;

    for (const ch of value) {
        if (GSM7_BASIC_SET.has(ch)) { units += 1; continue; }
        if (GSM7_EXTENDED_SET.has(ch)) { units += 2; continue; }
        gsm7 = false;
        break;
    }

    if (!gsm7) {
        // UCS-2 is billed per 16-bit unit, so an astral emoji costs two.
        units = 0;
        for (const ch of value) units += ch.length;
    }

    const single = gsm7 ? 160 : 70;
    const multi = gsm7 ? 153 : 67;

    if (units === 0) {
        return { encoding: gsm7 ? 'GSM-7' : 'UCS-2', characters: 0, limit: single, perSegment: multi, segments: 0, remaining: single };
    }
    if (units <= single) {
        return { encoding: gsm7 ? 'GSM-7' : 'UCS-2', characters: units, limit: single, perSegment: multi, segments: 1, remaining: single - units };
    }

    const segments = Math.ceil(units / multi);
    return {
        encoding: gsm7 ? 'GSM-7' : 'UCS-2',
        characters: units,
        limit: segments * multi,
        perSegment: multi,
        segments,
        remaining: segments * multi - units,
    };
};

/**
 * Clean a display name down to something safe to prepend.
 *
 * Newlines and control characters are stripped rather than rejected: they would
 * otherwise let a stored name break the message into what looks like two texts,
 * and an operator pasting a name out of a spreadsheet should not have to care.
 */
export const sanitizeDisplayName = (raw: unknown): string =>
    String(raw ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001F\u007F-\u009F]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SMS_DISPLAY_NAME_MAX)
        .trim();

/**
 * Clean a requested sender id. The networks only accept letters, digits and
 * spaces, up to 11 characters, so anything else is dropped here rather than
 * rejected by the operator after the store thinks it is set up.
 */
export const sanitizeSenderId = (raw: unknown): string =>
    String(raw ?? '')
        .replace(/[^A-Za-z0-9 ]+/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, SMS_SENDER_ID_MAX)
        .trim();

/** The exact string prepended for a display name, including the separator. */
export const displayNamePrefix = (displayName: string): string => {
    const name = sanitizeDisplayName(displayName);
    return name ? `${name}: ` : '';
};

/**
 * Prepend the store name, unless the text already opens with it.
 *
 * The second half matters more than it looks: a cashier who types the shop name
 * out of habit, a saved template that already carries it, or a re-send of a
 * message read back out of the log would otherwise all go out as
 * "Kay Hardware: Kay Hardware: ...".
 */
export const applyDisplayName = (displayName: string, message: string): string => {
    const body = (message || '').trim();
    const name = sanitizeDisplayName(displayName);
    if (!name) return body;
    const prefix = displayNamePrefix(name);
    const lower = body.toLowerCase();
    // Already prefixed, with or without the colon/space we would add.
    if (lower.startsWith(prefix.toLowerCase())) return body;
    if (lower.startsWith(name.toLowerCase())) {
        const rest = body.slice(name.length);
        if (/^\s*[:\-–,]/.test(rest) || rest === '') return body;
    }
    return prefix + body;
};

export interface SmsBranding {
    /** Store display name (store_settings.sms_display_name). */
    displayName?: string | null;
    /** Sender id the store has had APPROVED. Pending values must not be passed. */
    senderId?: string | null;
    senderIdStatus?: SmsSenderIdStatus | string | null;
}

export interface OutboundSms {
    /** The text the customer receives, prefix included. */
    text: string;
    /** `from` for the provider call; undefined falls back to the platform id. */
    from?: string;
    /** The prefix actually applied, for the outreach log. '' when none. */
    prefix: string;
    segments: SmsSegmentInfo;
}

/**
 * Decide what goes out: which sender, and whether the body needs the prefix.
 *
 * An approved sender id already puts the store's name on the handset, so the
 * prefix would be wasted characters — and characters here are money.
 */
export const resolveOutboundSms = (branding: SmsBranding, message: string): OutboundSms => {
    const approved = branding.senderIdStatus === 'approved' ? sanitizeSenderId(branding.senderId) : '';
    if (approved) {
        const text = (message || '').trim();
        return { text, from: approved, prefix: '', segments: smsSegments(text) };
    }
    const text = applyDisplayName(branding.displayName || '', message);
    const prefix = text === (message || '').trim() ? '' : displayNamePrefix(branding.displayName || '');
    return { text, from: undefined, prefix, segments: smsSegments(text) };
};

export interface SenderIdRequest {
    /** Currently approved value, if any. */
    currentSenderId?: string | null;
    currentStatus?: SmsSenderIdStatus | string | null;
    /** Value the store already has in review. */
    currentRequested?: string | null;
    /** What the caller is asking for; undefined means "field not sent". */
    requested?: unknown;
    /** Only a superadmin may move a value into the approved column. */
    isSuperAdmin?: boolean;
}

export interface SenderIdDecision {
    /** Approved sender id to store. Only a superadmin can change this. */
    senderId: string | null;
    requestedSenderId: string | null;
    status: SmsSenderIdStatus;
    /** False when nothing should be written (field absent / no change). */
    changed: boolean;
}

/**
 * A store asking for a sender id is a request, never a grant.
 *
 * An alphanumeric sender has to be registered with MTN, Airtel and Zamtel, and
 * an unregistered one is rewritten or dropped by the operator. Worse, nothing
 * about the string itself stops a shop typing a bank's name into the box. So a
 * store's save only ever fills the pending column; moving it across is a
 * superadmin action, the same way premium modules are granted.
 */
export const resolveSenderIdRequest = (input: SenderIdRequest): SenderIdDecision => {
    const currentApproved = sanitizeSenderId(input.currentSenderId);
    const currentRequested = sanitizeSenderId(input.currentRequested);
    const currentStatus = (input.currentStatus as SmsSenderIdStatus) || (currentApproved ? 'approved' : 'none');

    const unchanged: SenderIdDecision = {
        senderId: currentApproved || null,
        requestedSenderId: currentRequested || null,
        status: currentStatus,
        changed: false,
    };

    if (input.requested === undefined) return unchanged;

    const wanted = sanitizeSenderId(input.requested);

    if (!wanted) {
        // Withdrawing the request. A superadmin clearing it also revokes the
        // approval; a store can only take back what it asked for.
        if (input.isSuperAdmin) {
            if (!currentApproved && !currentRequested) return unchanged;
            return { senderId: null, requestedSenderId: null, status: 'none', changed: true };
        }
        if (!currentRequested) return unchanged;
        return { senderId: currentApproved || null, requestedSenderId: null, status: currentApproved ? 'approved' : 'none', changed: true };
    }

    if (input.isSuperAdmin) {
        if (currentApproved === wanted && currentStatus === 'approved') return unchanged;
        return { senderId: wanted, requestedSenderId: null, status: 'approved', changed: true };
    }

    // A store re-asking for what it already has approved changes nothing.
    if (currentApproved === wanted && currentStatus === 'approved') return unchanged;
    if (currentRequested === wanted && currentStatus === (currentApproved ? 'approved' : 'pending')) return unchanged;
    return {
        senderId: currentApproved || null,
        requestedSenderId: wanted,
        // A store that already has a working sender id and asks for a different
        // one stays approved: whether a request is outstanding is told by
        // requestedSenderId, and letting it flip the status to 'pending' would
        // quietly stop using the id the networks have already granted.
        status: currentApproved ? 'approved' : 'pending',
        changed: true,
    };
};
