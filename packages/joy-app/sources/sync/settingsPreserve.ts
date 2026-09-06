/**
 * Forward-compatibility for NESTED settings.
 *
 * settingsParse validates each known top-level field with its Zod schema, and
 * Zod's nested `z.object`s STRIP keys they do not know. A newer client's
 * voice-agent fields, or an `opencode` entry in dismissedCLIWarnings, vanished
 * the moment this client parsed them — and its next settings write synced the
 * stripped objects back, deleting the newer client's configuration (#400).
 * Unknown TOP-level keys always survived; this extends the same rule down the
 * tree: every key the schema did not consume is carried over from the
 * original value, recursively, while validated known values win.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Merge keys present in `original` but absent from `parsed` back into
 * `parsed`, recursing into nested objects and same-length arrays. Values the
 * schema validated (`parsed`) always take precedence; only what it dropped is
 * restored. Anything that is not a plain object/array on both sides is
 * returned as parsed.
 */
export function preserveUnknownFields<T>(parsed: T, original: unknown): T {
    if (isPlainObject(parsed) && isPlainObject(original)) {
        const out: Record<string, unknown> = { ...parsed };
        for (const key of Object.keys(original)) {
            // Own keys only: `'constructor' in out` is true through the
            // prototype, and assigning `__proto__` would rewrite it.
            if (key === '__proto__') continue;
            if (!Object.prototype.hasOwnProperty.call(out, key)) {
                out[key] = original[key];
            } else {
                out[key] = preserveUnknownFields(out[key], original[key]);
            }
        }
        return out as T;
    }
    if (Array.isArray(parsed) && Array.isArray(original) && parsed.length === original.length) {
        // Element-wise: an array of objects (voiceAgents, recentMachinePaths)
        // keeps each element's unknown fields. A length change means the
        // schema rejected/reshaped it — keep the validated array as is.
        return parsed.map((item, i) => preserveUnknownFields(item, original[i])) as unknown as T;
    }
    return parsed;
}
