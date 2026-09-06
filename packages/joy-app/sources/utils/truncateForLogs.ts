const DEFAULT_MAX_STRING_LENGTH = 500;
const MAX_DEPTH = 10;

const TRUNCATION_MARKER = ' [... TRUNCATED FOR LOGS] ';

function truncateString(value: string, maxLength: number): string {
    // Validate the limit before slicing: a NaN/negative/fractional limit is
    // clamped to a whole number >= 0 instead of producing odd slice bounds.
    const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
    if (value.length <= limit) return value;
    const prefixLen = Math.ceil(limit * 0.4);
    const suffixLen = Math.floor(limit * 0.3);
    // `slice(-0)` is `slice(0)` — the WHOLE string. Limits 0..3 gave suffixLen
    // 0 and copied the entire untruncated value into the log (#461).
    const suffix = suffixLen > 0 ? value.slice(-suffixLen) : '';
    return value.slice(0, prefixLen) + TRUNCATION_MARKER + suffix;
}

export function truncateForLogs(value: unknown, maxStringLength = DEFAULT_MAX_STRING_LENGTH, _depth = 0): unknown {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') return truncateString(value, maxStringLength);
    if (typeof value !== 'object') return value;
    if (_depth >= MAX_DEPTH) return '[...]';

    if (Array.isArray(value)) {
        return value.map(item => truncateForLogs(item, maxStringLength, _depth + 1));
    }

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        result[key] = truncateForLogs(val, maxStringLength, _depth + 1);
    }
    return result;
}

export function serializeForLogs(value: unknown, maxStringLength = DEFAULT_MAX_STRING_LENGTH): string {
    if (typeof value === 'string') return truncateString(value, maxStringLength);

    const truncated = truncateForLogs(value, maxStringLength);
    try {
        return JSON.stringify(truncated, null, 2) ?? String(truncated);
    } catch {
        return String(truncated);
    }
}
