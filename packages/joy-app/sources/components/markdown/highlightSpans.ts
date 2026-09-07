import type { MarkdownSpan } from './parseMarkdown';

/** A span carrying whether it is part of a search hit. */
export type HighlightableSpan = MarkdownSpan & { highlighted?: boolean };

/**
 * Split spans so every occurrence of `query` becomes its own span, marked.
 *
 * Search used to scroll to a match and mark nothing (#639), which reads as
 * "search is broken": you land on a wall of text with no idea which words were
 * hit. Splitting at the span level keeps the marking inside the existing
 * renderer — a hit that straddles bold and plain text marks both halves,
 * because each is a separate span already.
 *
 * A hit that spans a span BOUNDARY is not found, by design: the text either
 * side belongs to different styled runs, and stitching them would mean
 * re-deriving the whole block's plain text and mapping offsets back. The
 * search bar matches on the message's raw text, so this only under-marks a hit
 * that markdown formatting splits mid-phrase — rare, and it still scrolls.
 */
export function highlightSpans(spans: MarkdownSpan[], query: string | undefined): HighlightableSpan[] {
    const q = query?.trim().toLowerCase();
    if (!q) return spans;

    const out: HighlightableSpan[] = [];
    for (const span of spans) {
        const lower = span.text.toLowerCase();
        if (!lower.includes(q)) {
            out.push(span);
            continue;
        }

        let cursor = 0;
        for (;;) {
            const at = lower.indexOf(q, cursor);
            if (at === -1) break;
            if (at > cursor) {
                out.push({ ...span, text: span.text.slice(cursor, at) });
            }
            out.push({ ...span, text: span.text.slice(at, at + q.length), highlighted: true });
            cursor = at + q.length;
        }
        if (cursor < span.text.length) {
            out.push({ ...span, text: span.text.slice(cursor) });
        }
    }
    return out;
}
