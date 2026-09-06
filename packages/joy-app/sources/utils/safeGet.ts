/**
 * Prototype-safe lookups for plain-object maps keyed by USER data.
 *
 * `record[key]` on a plain object walks the prototype chain, so a key like
 * "__proto__", "constructor" or "toString" coming from a tool name, a slash
 * command, a file extension, an OS string or a saved preference resolves to
 * Object.prototype members instead of "not found". Downstream that becomes a
 * React element of type Object (crash), a description that is a function, a
 * MIME type of "[object Object]", or a language that silently disables every
 * translation (#293, #405, #419, #434, #453).
 *
 * Every lookup of a plain-object map by an externally supplied key goes
 * through one of these two helpers.
 */

/** True only when `obj` has `key` as its OWN property (never inherited). */
export function hasOwn(obj: object | null | undefined, key: PropertyKey): boolean {
    if (obj === null || obj === undefined) return false;
    return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Own-property read: the value stored under `key`, or undefined when the key
 * is missing OR only reachable through the prototype chain.
 */
export function safeGet<T>(record: Record<string, T> | null | undefined, key: string): T | undefined {
    if (!hasOwn(record, key)) return undefined;
    return (record as Record<string, T>)[key];
}
