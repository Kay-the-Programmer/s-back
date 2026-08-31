/**
 * The canonical public app URL used to build links in emails and notifications.
 * Reads FRONTEND_URL and falls back to the production site — never a localhost
 * dev URL — so CTA links are always valid even if the env var is unset.
 * Any trailing slashes are trimmed so callers can safely append paths.
 */
export const appUrl = (): string =>
    (process.env.FRONTEND_URL || 'https://www.salepilot.space').replace(/\/+$/, '');

/**
 * Generates a unique ID with a given prefix.
 * e.g., generateId('prod') => 'prod_1678886400000_a1b2c3d4'
 * @param prefix - The prefix for the ID (e.g., 'prod', 'user').
 * @returns A unique string ID.
 */
export const generateId = (prefix: string): string => {
    const timestamp = Date.now();
    const randomPart = Math.random().toString(36).substring(2, 9);
    return `${prefix}-${timestamp}-${randomPart}`;
};


/**
 * Converts a Date object to a 'YYYY-MM-DD' string.
 * @param date - The date to convert.
 * @returns The formatted date string.
 */
export const toDateInputString = (date: Date): string => {
    const year = date.getFullYear();
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const day = date.getDate().toString().padStart(2, '0');
    return `${year}-${month}-${day}`;
};

/** A plain calendar day, `YYYY-MM-DD`, with no time and no zone. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Normalise a temporal value for the wire: ISO 8601 UTC.
 *
 * This used to render a human string — `"Aug 11, 2026, 11:24:50 AM"` — in the
 * server's locale, and it was the source of every wrong clock in the product.
 * That format carries no timezone, so a client reading it treated a UTC instant
 * as local time and showed a sale rung up seconds ago as two hours old in
 * Zambia (UTC+2). Dart could not parse it at all, so the desktop till saw no
 * date whatsoever. It also sorts wrong as text and loses milliseconds.
 *
 * An API's job is to state the instant unambiguously; how it reads is the
 * client's business, and every client already has a formatter that expects ISO.
 *
 * Date-only values are passed through untouched: a due date is the same day
 * everywhere, and giving it a time would invite exactly the shifting this fixes.
 */
export const toIsoInstant = (value: string | Date): string => {
    try {
        if (typeof value === 'string' && DATE_ONLY.test(value)) return value;

        const date = value instanceof Date ? value : new Date(value);
        if (isNaN(date.getTime())) {
            // Not a date at all — hand back what came in rather than inventing one.
            return String(value);
        }
        return date.toISOString();
    } catch {
        return String(value);
    }
};

/**
 * Converts snake_case keys to camelCase recursively and formats timestamp fields.
 * Handles nested objects and arrays automatically.
 * @param obj - The object to convert (can be object, array, or primitive).
 * @returns The object with camelCase keys and formatted timestamps.
 */
export const toCamelCase = (obj: any): any => {
    if (obj === null || obj === undefined) {
        return obj;
    }

    if (Array.isArray(obj)) {
        return obj.map(toCamelCase);
    }

    if (typeof obj !== 'object' || obj instanceof Date) {
        return obj;
    }

    const camelCaseObj: any = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            let value = obj[key];

            // Format timestamp fields - check for common timestamp field names
            // Exclude Lenco keys which might contain date-like strings but are not timestamps
            if ((key === 'timestamp' || key === 'created_at' || key === 'updated_at' ||
                key === 'ordered_at' || key === 'expected_at' || key === 'date' ||
                key === 'due_date' || key === 'received_at' || key === 'start_time' ||
                key === 'end_time') && value && (key as any) !== 'lenco_public_key' && (key as any) !== 'lenco_secret_key') {

                // DATE columns arrive as `YYYY-MM-DD` (see the 1082 parser in
                // db_client) and are left alone; everything else becomes an
                // unambiguous UTC instant.
                if (value instanceof Date || typeof value === 'string') {
                    value = toIsoInstant(value);
                } else {
                    console.warn(`Unexpected timestamp format for key ${key}:`, typeof value, value);
                }
            }

            camelCaseObj[camelKey] = toCamelCase(value);
        }
    }
    return camelCaseObj;
};