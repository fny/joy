// Idempotency keys for relay sends. The relay dedupes by clientIntentId ALONE
// (the first acceptance is returned whatever the new payload is), so a key must
// be reused for exactly one thing: a RETRY of a payload whose earlier send
// FAILED. Every other send — a second message with identical text while the
// first is pending, an edited restore, a different draft — gets a fresh id.
//
// A hash of the payload is not an identity (32-bit hashes collide on two-
// character strings — Astra found 'bC' vs 'cb'); the key is a random uuid and
// reuse is decided by exact payload equality on a failed entry (#7, #10).
import { randomUUID } from 'expo-crypto';

type Entry = { key: string; payload: string; state: 'pending' | 'failed'; began: number; failedAt?: number };
const entries = new Map<string, Entry[]>(); // scope → sends in flight or failed
let clock = 0; // orders begins and failures within a scope
const MAX_FAILED_PER_SCOPE = 50;

function payloadOf(text: string, attachmentIds: readonly string[]): string {
    return JSON.stringify([text, [...attachmentIds]]);
}

/** Key for a send about to start: reuses a FAILED send's key when the payload
 *  is exactly the same (a retry), otherwise mints a new one. */
export function beginSend(scope: string, text: string, attachmentIds: readonly string[] = []): string {
    const payload = payloadOf(text, attachmentIds);
    const list = entries.get(scope) ?? [];
    const failed = list.find((e) => e.state === 'failed' && e.payload === payload);
    // A retry is a NEW begin in the scope's order: its success must retire
    // failures older than the retry, not only those older than the first
    // attempt (Astra on ba243ffb).
    if (failed) { failed.state = 'pending'; failed.began = ++clock; return failed.key; }
    const entry: Entry = { key: randomUUID(), payload, state: 'pending', began: ++clock };
    // Bounded: abandoned failures never pile up. Only FAILED entries are
    // evicted (oldest first) — a pending identity is never safe to forget.
    const next = [...list, entry];
    let failedCount = next.filter((e) => e.state === 'failed').length;
    const kept = next.filter((e) => { if (e.state === 'failed' && failedCount > MAX_FAILED_PER_SCOPE) { failedCount--; return false; } return true; });
    entries.set(scope, kept);
    return entry.key;
}

/** The relay accepted this key: forget it (an identical later message is new).
 *  Failures that happened BEFORE this send began are forgotten too: the user
 *  moved past that text to compose something else, so typing it again later
 *  is a new message, not a retry (Astra on 7d4cd645, #7). A failure that
 *  happened after this send began is untouched — two concurrent sends where
 *  one lost its ack must still be able to replay the other (Astra on bfcec9fd). */
export function sendSucceeded(scope: string, key: string): void {
    const all = entries.get(scope) ?? [];
    const me = all.find((e) => e.key === key);
    const list = all.filter((e) => e.key !== key && !(e.state === 'failed' && me !== undefined && (e.failedAt ?? 0) < me.began));
    if (list.length) entries.set(scope, list); else entries.delete(scope);
}

/** The send failed: keep the key so an unchanged retry replays the acceptance
 *  the relay may already hold. */
export function sendFailed(scope: string, key: string): void {
    for (const e of entries.get(scope) ?? []) if (e.key === key) { e.state = 'failed'; e.failedAt = ++clock; }
}
