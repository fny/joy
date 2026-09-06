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

type Entry = { key: string; payload: string; state: 'pending' | 'failed' };
const entries = new Map<string, Entry[]>(); // scope → sends in flight or failed

function payloadOf(text: string, attachmentIds: readonly string[]): string {
    return JSON.stringify([text, [...attachmentIds]]);
}

/** Key for a send about to start: reuses a FAILED send's key when the payload
 *  is exactly the same (a retry), otherwise mints a new one. */
export function beginSend(scope: string, text: string, attachmentIds: readonly string[] = []): string {
    const payload = payloadOf(text, attachmentIds);
    const list = entries.get(scope) ?? [];
    const failed = list.find((e) => e.state === 'failed' && e.payload === payload);
    if (failed) { failed.state = 'pending'; return failed.key; }
    const entry: Entry = { key: randomUUID(), payload, state: 'pending' };
    entries.set(scope, [...list, entry].slice(-50)); // bounded: abandoned failures never pile up
    return entry.key;
}

/** The relay accepted this key: forget it (an identical later message is new).
 *  Earlier FAILED entries in the scope are forgotten too: the user moved past
 *  that text to send something else, so typing it again later is a new
 *  message, not a retry of the abandoned one (Astra on 7d4cd645, #7). */
export function sendSucceeded(scope: string, key: string): void {
    const list = (entries.get(scope) ?? []).filter((e) => e.key !== key && e.state !== 'failed');
    if (list.length) entries.set(scope, list); else entries.delete(scope);
}

/** The send failed: keep the key so an unchanged retry replays the acceptance
 *  the relay may already hold. */
export function sendFailed(scope: string, key: string): void {
    for (const e of entries.get(scope) ?? []) if (e.key === key) e.state = 'failed';
}
