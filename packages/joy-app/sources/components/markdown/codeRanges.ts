// Markdown code regions — fenced blocks and inline `code` — as [start, end)
// character ranges. Pre-parsers that pull pseudo-XML out of a message before
// the markdown renderer sees it (<joy-img …/> attachments, harness
// <system-reminder> noise) must leave a QUOTED example alone: a fenced HTML
// sample containing a joy tag became a live attachment and split its own
// fence (#436), and a fenced <system-reminder> example was deleted (#270).
//
// Single pass, linear in the text: fences follow parseMarkdownBlock's rule
// (an opening run of 3+ backticks closes only on a run at least as long,
// #263); inline code is a backtick run closed by an equal run on the same
// line. An unclosed fence runs to the end of the text (streaming: the closing
// fence has not arrived yet, so nothing inside is a tag either).

export type CodeRange = { start: number; end: number };

function backtickRun(text: string, at: number): number {
    let n = 0;
    while (text.charCodeAt(at + n) === 96 /* ` */) n++;
    return n;
}

export function findCodeRanges(text: string): CodeRange[] {
    const ranges: CodeRange[] = [];
    const len = text.length;
    let lineStart = 0;
    let fenceOpen: { start: number; size: number } | null = null;

    while (lineStart <= len) {
        let lineEnd = text.indexOf('\n', lineStart);
        if (lineEnd === -1) lineEnd = len;

        // Leading whitespace is allowed before a fence, like the block parser's trim().
        let i = lineStart;
        while (i < lineEnd && (text[i] === ' ' || text[i] === '\t')) i++;
        const run = backtickRun(text, i);

        if (fenceOpen) {
            // A closing fence is a line of only backticks (>= opening size).
            if (run >= fenceOpen.size && i + run === lineEnd) {
                ranges.push({ start: fenceOpen.start, end: lineEnd });
                fenceOpen = null;
            }
        } else if (run >= 3) {
            fenceOpen = { start: lineStart, size: run };
        } else {
            // Inline code: a backtick run closed by an equal-length run on this line.
            let j = lineStart;
            while (j < lineEnd) {
                if (text.charCodeAt(j) !== 96) { j++; continue; }
                const open = backtickRun(text, j);
                let k = j + open;
                let closed = -1;
                while (k < lineEnd) {
                    if (text.charCodeAt(k) !== 96) { k++; continue; }
                    const close = backtickRun(text, k);
                    if (close === open) { closed = k + close; break; }
                    k += close;
                }
                if (closed === -1) { j += open; continue; }
                ranges.push({ start: j, end: closed });
                j = closed;
            }
        }

        lineStart = lineEnd + 1;
    }

    if (fenceOpen) ranges.push({ start: fenceOpen.start, end: len });
    return ranges;
}

/** True when `index` falls inside one of the (sorted, disjoint) ranges. */
export function isInsideCode(ranges: CodeRange[], index: number): boolean {
    for (const r of ranges) {
        if (index < r.start) return false;
        if (index < r.end) return true;
    }
    return false;
}
