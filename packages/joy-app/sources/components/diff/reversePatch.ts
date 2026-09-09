/**
 * Reconstruct the file as it was BEFORE a change, from the file as it is now
 * plus the unified patch that produced it.
 *
 * The Changes panel shows a patch: the changed hunks with a few lines of
 * context and nothing else. To show the same change against the COMPLETE
 * file, the renderer needs both sides in full — it already has the current
 * file (`files/read`), and the patch carries every line the change removed,
 * so the previous file can be rebuilt by walking the current one and
 * swapping each hunk's new-side lines for its old-side lines.
 *
 * The "\\ No newline at end of file" markers are load-bearing: they are the
 * only record of which SIDE lacked a final newline, and dropping them
 * rebuilt a file that differed from the original by exactly one empty line
 * (caught against 157 real commits of this repo, where one file's previous
 * revision had no trailing newline).
 *
 * Every line the patch claims is verified against the file as it stands. A
 * patch that does not describe this file — the working tree moved on between
 * the two reads, a hunk that overlaps another — returns null rather than a
 * plausible-looking reconstruction, and the caller falls back to the patch
 * view. A wrong "complete file" is worse than no complete file.
 */

export interface PatchHunk {
    /** 1-based first line on the old side; 0 when the hunk only adds. */
    oldStart: number;
    oldCount: number;
    /** 1-based first line on the new side; 0 when the hunk only removes. */
    newStart: number;
    newCount: number;
    /** Body lines, each still carrying its ' ', '+', '-' or '\' marker. */
    lines: string[];
}

const HUNK_HEADER = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/** Lines that belong to a file header rather than a hunk body. */
function isHeaderLine(line: string): boolean {
    return line.startsWith('diff ')
        || line.startsWith('index ')
        || line.startsWith('--- ')
        || line.startsWith('+++ ')
        || line.startsWith('old mode ')
        || line.startsWith('new mode ')
        || line.startsWith('similarity index ')
        || line.startsWith('rename ')
        || line.startsWith('copy ')
        || line.startsWith('deleted file mode ')
        || line.startsWith('new file mode ')
        || line.startsWith('Binary files ')
        || line.startsWith('GIT binary patch');
}

export function parseHunks(patch: string): PatchHunk[] {
    const hunks: PatchHunk[] = [];
    let current: PatchHunk | null = null;
    for (const line of patch.split('\n')) {
        const header = HUNK_HEADER.exec(line);
        if (header) {
            current = {
                oldStart: Number(header[1]),
                oldCount: header[2] === undefined ? 1 : Number(header[2]),
                newStart: Number(header[3]),
                newCount: header[4] === undefined ? 1 : Number(header[4]),
                lines: [],
            };
            hunks.push(current);
            continue;
        }
        if (!current) continue;         // preamble before the first hunk
        if (isHeaderLine(line)) {       // a second file in the same patch
            current = null;
            continue;
        }
        current.lines.push(line);
    }
    // A trailing "" from the patch's own final newline is not a context line.
    for (const h of hunks) {
        if (h.lines.length > 0 && h.lines[h.lines.length - 1] === '' && countSide(h, 'new') > h.newCount) {
            h.lines.pop();
        }
    }
    return hunks;
}

/** How many lines of one side a hunk body actually carries. */
function countSide(hunk: PatchHunk, side: 'old' | 'new'): number {
    let n = 0;
    for (const line of hunk.lines) {
        if (line.startsWith('\\')) continue;
        const marker = line[0] ?? ' ';
        if (marker === '+') { if (side === 'new') n++; }
        else if (marker === '-') { if (side === 'old') n++; }
        else n++;
    }
    return n;
}

/**
 * The file before the change, or null when the patch does not describe
 * `newText` line for line.
 */
export function reconstructOldText(newText: string, patch: string): string | null {
    const hunks = parseHunks(patch);
    if (hunks.length === 0) return null;
    const newLines = newText.split('\n');
    const out: string[] = [];
    let cursor = 0; // next line of newLines still to be accounted for
    // A marker applies to the line above it, and only ever at end of file:
    // after a '-' or context line the OLD side has no final newline, after a
    // '+' or context line the NEW side has none.
    let noNewlineOld = false;
    let noNewlineNew = false;

    for (const hunk of hunks) {
        // newCount 0 means "removed at this point": newStart is the line the
        // removal follows, not a line the hunk occupies.
        const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
        if (start < cursor || start > newLines.length) return null;
        for (let i = cursor; i < start; i++) out.push(newLines[i]);

        let index = start;
        let previousMarker = ' ';
        for (const line of hunk.lines) {
            if (line.startsWith('\\')) { // "\ No newline at end of file"
                if (previousMarker === '-' || previousMarker === ' ') noNewlineOld = true;
                if (previousMarker === '+' || previousMarker === ' ') noNewlineNew = true;
                continue;
            }
            const marker = line[0] ?? ' ';
            previousMarker = line === '' ? ' ' : marker;
            const content = line === '' ? '' : line.slice(1);
            if (marker === '-') {
                out.push(content);        // old only
                continue;
            }
            // ' ' (context) and '+' both occupy a line of the current file.
            if (newLines[index] !== content) return null;
            if (marker !== '+') out.push(content); // context survives on both sides
            index++;
        }
        cursor = index;
    }
    for (let i = cursor; i < newLines.length; i++) out.push(newLines[i]);
    // split('\n') renders a final newline as a trailing empty element, so the
    // old side's final newline is added or removed here rather than guessed
    // from the new side's.
    if (noNewlineOld) {
        if (out.length > 0 && out[out.length - 1] === '') out.pop();
    } else if (noNewlineNew) {
        if (out.length > 0 && out[out.length - 1] !== '') out.push('');
    }
    return out.join('\n');
}
