/**
 * Remembers what each relay row decrypted to, so the poll only decrypts rows
 * that changed.
 *
 * The session list is re-fetched every 2.5 s as the baseline live channel.
 * fetchSessions was written as a cold load — fetch, decrypt every row, apply —
 * and then reused as that poll's body, so every tick re-opened every session
 * key (an asymmetric box open) and re-opened every card (a secretbox open),
 * for an account's worth of rows, whether or not a single byte had changed.
 * At idle that was the app's baseline CPU.
 *
 * Same ciphertext under the same key envelope is the same plaintext, by
 * definition, so a row whose two strings match the last tick's needs no
 * crypto at all — its previous result is reused. A failure to open is
 * remembered the same way: the same bytes fail the same way.
 *
 * Pure and dependency-free, so it is testable without the store or sodium.
 */
export interface MemoRow {
    sessionId: string;
    sessionKeyEnvelope: string | null | undefined;
    encryptedMetadata: string | null | undefined;
}

interface Entry<T> {
    envelope: string | null;
    ciphertext: string | null;
    value: T;
}

export class CardMemo<T> {
    #entries = new Map<string, Entry<T>>();
    /** Counters for tests and the log line: how much work the memo saved. */
    hits = 0;
    misses = 0;

    /** The remembered result for this row, if its bytes are unchanged. */
    lookup(row: MemoRow): { hit: true; value: T } | { hit: false } {
        const e = this.#entries.get(row.sessionId);
        if (e && e.envelope === (row.sessionKeyEnvelope ?? null) && e.ciphertext === (row.encryptedMetadata ?? null)) {
            this.hits++;
            return { hit: true, value: e.value };
        }
        this.misses++;
        return { hit: false };
    }

    remember(row: MemoRow, value: T): void {
        this.#entries.set(row.sessionId, {
            envelope: row.sessionKeyEnvelope ?? null,
            ciphertext: row.encryptedMetadata ?? null,
            value,
        });
    }

    /** Drop everything not in `live` — a session the relay no longer lists. */
    prune(live: Iterable<string>): void {
        const keep = new Set(live);
        for (const id of this.#entries.keys()) if (!keep.has(id)) this.#entries.delete(id);
    }

    clear(): void { this.#entries.clear(); }
    get size(): number { return this.#entries.size; }
}
