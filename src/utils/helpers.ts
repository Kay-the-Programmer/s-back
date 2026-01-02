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

/**
 * Formats a timestamp string or Date object to a more readable format.
 * @param timestamp - The timestamp to format (string or Date).
 * @returns The formatted timestamp string.
 */
export const formatTimestamp = (timestamp: string | Date): string => {
    try {
        let date: Date;

        if (timestamp instanceof Date) {
            date = timestamp;
        } else if (typeof timestamp === 'string') {
            date = new Date(timestamp);
        } else {
            console.warn('Invalid timestamp type:', typeof timestamp, timestamp);
            return String(timestamp);
        }

        // Check if the date is valid
        if (isNaN(date.getTime())) {
            console.warn('Invalid date:', timestamp);
            return String(timestamp);
        }

        return date.toLocaleString('en-US', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: true
        });
    } catch (error) {
        console.warn('Error formatting timestamp:', timestamp, error);
        return String(timestamp);
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

    if (typeof obj !== 'object') {
        return obj;
    }

    const camelCaseObj: any = {};
    for (const key in obj) {
        if (obj.hasOwnProperty(key)) {
            const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
            let value = obj[key];

            // Format timestamp fields - check for common timestamp field names
            if ((key === 'timestamp' || key === 'created_at' || key === 'updated_at' ||
                key === 'ordered_at' || key === 'expected_at' || key === 'date' ||
                key === 'due_date' || key === 'received_at' || key === 'start_time' ||
                key === 'end_time') && value) {

                // Handle both string and Date object timestamps
                if (typeof value === 'string' || value instanceof Date) {
                    value = formatTimestamp(value);
                } else {
                    console.warn(`Unexpected timestamp format for key ${key}:`, typeof value, value);
                }
            }

            camelCaseObj[camelKey] = toCamelCase(value);
        }
    }
    return camelCaseObj;
};