// Markdown code regions — fenced blocks and inline `code` — as [start, end)
// character ranges. Pre-parsers that pull pseudo-XML out of a message before
// the markdown renderer sees it (<joy-img …/> attachments, harness
// <system-reminder> noise) must leave a QUOTED example alone: a fenced HTML
// sample containing a joy tag became a live attachment and split its own
// fence (#436), and a fenced <system-reminder> example was deleted (#270).
//
// Single pass, linear in the text: fences follow parseMarkdownBlock's rule
// (an opening run of 3+ backticks closes only on a run at least as long,
// #263; a closing fence may carry trailing spaces/tabs or a CR, like the
// block parser's trim()); inline code is a backtick run closed by the next
// run of equal length on the same line. An unclosed fence runs to the end of
// the text (streaming: the closing fence has not arrived yet, so nothing
// inside is a tag either).

export type CodeRange = { start: number; end: number };

function backtickRun(text: string, at: number): number {
    let n = 0;
    while (text.charCodeAt(at + n) === 96 /* ` */) n++;
    return n;
}

function isFenceTrailer(code: number): boolean {
    return code === 32 /* space */ || code === 9 /* tab */ || code === 13 /* CR */;
}

/**
 * Inline code spans on one line, appended to `ranges`. The runs are indexed
 * first and each opener is paired with the NEXT run of the same length via
 * a per-length lookup, so the line costs O(runs): rescanning the rest of the
 * line from every unmatched opener was quadratic — one line of successively
 * longer runs took ~8 s at 720 KB.
 */
function inlineCodeRanges(text: string, lineStart: number, lineEnd: number, ranges: CodeRange[]): void {
    const starts: number[] = [];
    const sizes: number[] = [];
    let j = lineStart;
    while (j < lineEnd) {
        if (text.charCodeAt(j) !== 96) { j++; continue; }
        const run = backtickRun(text, j);
        starts.push(j);
        sizes.push(run);
        j += run;
    }
    if (starts.length < 2) return;

    // nextSame[i] = index of the first later run with the same length, or -1.
    const nextSame = new Array<number>(starts.length);
    const seen = new Map<number, number>();
    for (let i = starts.length - 1; i >= 0; i--) {
        nextSame[i] = seen.get(sizes[i]) ?? -1;
        seen.set(sizes[i], i);
    }

    let i = 0;
    while (i < starts.length) {
        const close = nextSame[i];
        if (close === -1) { i++; continue; }
        ranges.push({ start: starts[i], end: starts[close] + sizes[close] });
        i = close + 1;
    }
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
            // A closing fence is a line of only backticks (>= opening size),
            // optionally followed by spaces, tabs or a CR. Requiring the run
            // to end exactly at the line break missed a CRLF or a trailing
            // space, so the fence never closed and a REAL tag after it was
            // treated as quoted (#436).
            let k = i + run;
            while (k < lineEnd && isFenceTrailer(text.charCodeAt(k))) k++;
            if (run >= fenceOpen.size && k === lineEnd) {
                ranges.push({ start: fenceOpen.start, end: lineEnd });
                fenceOpen = null;
            }
        } else if (run >= 3) {
            fenceOpen = { start: lineStart, size: run };
        } else {
            inlineCodeRanges(text, lineStart, lineEnd, ranges);
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

/**
 * `text.replace(re, replacer)` that leaves matches inside markdown code
 * untouched. Every harness rewrite goes through this — a quoted example is
 * the user's content, whatever tag it contains (#270, #436). The code-range
 * pass runs only when there is at least one match, so text without the
 * pattern pays nothing beyond the regex scan.
 */
export function replaceOutsideCode(
    text: string,
    re: RegExp,
    replacer: (match: RegExpExecArray) => string,
): string {
    re.lastIndex = 0;
    const first = re.exec(text);
    if (!first) return text;
    const codeRanges = findCodeRanges(text);
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null = first;
    while (m !== null) {
        if (!isInsideCode(codeRanges, m.index)) {
            out += text.slice(last, m.index) + replacer(m);
            last = m.index + m[0].length;
        }
        // A zero-length match would otherwise spin forever at one index.
        if (m[0].length === 0) re.lastIndex++;
        m = re.exec(text);
    }
    return out + text.slice(last);
}
