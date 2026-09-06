import type { Message, UnopenableGapMessage, UnopenableGapRange } from './typesMessage';
import { insertionIndexNewestFirst } from './messageOrdering';

/**
 * Project the chat's placeholder rows for a session's undecryptable spans
 * (#128) into its newest-first message list, at READ time. The rows are
 * synthetic: the reducer never sees them and the store's history never
 * holds them — the sync drops a span the moment its rows open, and the
 * placeholder goes with it.
 *
 * A row sorts at the oldest seq of its span, so it sits where the missing
 * rows begin; rows inside the span that DID open (a page is recorded whole)
 * follow it as usual.
 */
export function projectUnopenableGapRows(messages: Message[], ranges: UnopenableGapRange[]): Message[] {
    if (ranges.length === 0) return messages;
    const out = messages.slice();
    for (const range of ranges) {
        const row: UnopenableGapMessage = {
            kind: 'unopenable-gap',
            id: `unopenable-gap:${range.fromSeq}:${range.toSeq}`,
            seq: range.fromSeq + 1,
            createdAt: 0,
            count: range.count,
            fromSeq: range.fromSeq,
            toSeq: range.toSeq,
        };
        out.splice(insertionIndexNewestFirst(out, row), 0, row);
    }
    return out;
}
