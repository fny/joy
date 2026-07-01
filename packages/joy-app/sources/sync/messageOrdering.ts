import { Message } from "./typesMessage";

/**
 * Order chat messages newest-first by the server's authoritative `seq`
 * (monotonic + gap-free per session), NOT by createdAt. createdAt mixes two
 * clocks — agent session envelopes carry Claude's transcript-production time,
 * user messages carry joyTime/relay time — so a turn relayed late (e.g. after
 * the daemon catches up on a backlog) can sort out of order relative to the
 * user message that triggered it, and the positional turn grouping in
 * useGroupedMessages then mis-brackets and hides it.
 *
 * Messages with no seq (optimistic local sends not yet acked, pending
 * permission placeholders) are "happening now", so they sort as newest until
 * their real server row arrives and the reducer reconciles the seq. createdAt
 * then id are deterministic tiebreakers that keep this a total order (a
 * non-transitive comparator is undefined behaviour in Array.prototype.sort).
 */
export function compareMessagesNewestFirst(a: Message, b: Message): number {
    const aSeq = a.seq ?? Number.MAX_SAFE_INTEGER;
    const bSeq = b.seq ?? Number.MAX_SAFE_INTEGER;
    if (aSeq !== bSeq) return bSeq - aSeq;
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** Chronological (oldest-first) variant of {@link compareMessagesNewestFirst}. */
export function compareMessagesOldestFirst(a: Message, b: Message): number {
    return compareMessagesNewestFirst(b, a);
}

/** Binary-search the insertion index for `msg` in a newest-first sorted array
 *  (after any equal-keyed elements, matching Array.prototype.sort stability). */
export function insertionIndexNewestFirst(sorted: Message[], msg: Message): number {
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareMessagesNewestFirst(sorted[mid], msg) <= 0) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}
