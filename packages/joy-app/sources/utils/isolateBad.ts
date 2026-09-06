/**
 * "Keep the last good value / isolate the bad record."
 *
 * The app had ~a dozen sites where ONE bad input threw away everything good
 * around it: a malformed base64 row rejected a whole page of messages (#355),
 * one non-JSON box plaintext rejected a decryption batch (#352), one invalid
 * preference reset every local setting including app lock (#380) or every
 * synced setting including saved API keys (#399), a failed refresh erased the
 * last successful file list, a failed decryption was cached forever (#353,
 * #356). The rule applied at every site:
 *
 *   - a failed refresh never erases the last successful data;
 *   - one malformed record is skipped (and reported), never the batch;
 *   - a failed decryption is not cached — only verified plaintext is.
 *
 * These helpers are the mechanical part of that rule: per-item error
 * boundaries and per-field schema recovery.
 */
import * as z from 'zod';
import { hasOwn } from './safeGet';

/** Run `fn`; on throw report it and return null instead of propagating. */
export function attempt<T>(fn: () => T, report?: (error: unknown) => void): T | null {
    try {
        return fn();
    } catch (error) {
        report?.(error);
        return null;
    }
}

/** Async twin of attempt(). */
export async function attemptAsync<T>(fn: () => Promise<T>, report?: (error: unknown) => void): Promise<T | null> {
    try {
        return await fn();
    } catch (error) {
        report?.(error);
        return null;
    }
}

/**
 * Validate an object FIELD BY FIELD against a zod object shape. Every field
 * that parses keeps its value; every field that fails (or is missing) takes
 * its default and is listed in `invalidKeys` so the caller can report it.
 * Whole-object `safeParse` would have discarded the valid fields too.
 */
export function recoverFields<T extends Record<string, unknown>>(
    shape: Record<string, z.ZodType>,
    input: Record<string, unknown>,
    defaults: T,
): { value: T; invalidKeys: string[] } {
    const value: Record<string, unknown> = { ...(defaults as Record<string, unknown>) };
    const invalidKeys: string[] = [];
    for (const key of Object.keys(shape)) {
        if (!hasOwn(input, key) || input[key] === undefined) continue;
        const parsed = shape[key].safeParse(input[key]);
        if (parsed.success) {
            value[key] = parsed.data;
        } else {
            invalidKeys.push(key);
        }
    }
    return { value: value as T, invalidKeys };
}
