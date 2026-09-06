export type ParsedUnifiedDiff = {
    oldText: string;
    newText: string;
    fileName?: string;
};

export type UnifiedDiffFileKind = 'add' | 'delete' | 'update' | string | null | undefined;

export function materializeUnifiedDiffPatch(
    unifiedDiff: string,
    fileName: string,
    kind: UnifiedDiffFileKind = 'update',
): string {
    if (
        unifiedDiff.includes('\n--- ') ||
        unifiedDiff.startsWith('--- ') ||
        unifiedDiff.includes('\n+++ ') ||
        unifiedDiff.startsWith('+++ ') ||
        unifiedDiff.startsWith('diff --git ')
    ) {
        return unifiedDiff;
    }

    const oldPath = kind === 'add' ? '/dev/null' : `a/${fileName}`;
    const newPath = kind === 'delete' ? '/dev/null' : `b/${fileName}`;
    return `--- ${oldPath}\n+++ ${newPath}\n${unifiedDiff}`;
}

const DEV_NULL = '/dev/null';
const NO_NEWLINE_MARKER = '\\ No newline at end of file';

// "--- a/x", "+++ b/x", "--- /dev/null" — the shapes a file header takes. Inside
// a hunk a removed "-- SQL comment" line reads "--- SQL comment" and an added
// "++ x" reads "+++ x"; those are content, and were silently dropped (or taken
// for the new-file header, clobbering fileName) because the header test ran
// on every line (#108). Inside a hunk the header question is answered by the
// hunk's own line counts (see walkUnifiedDiff); this shape is the fallback
// for hunk fragments that carry no "@@" header at all.
const FILE_HEADER_RE = /^(---|\+\+\+) (?:"?[ab]\/|\/dev\/null)/;

// "@@ -12,3 +12,4 @@": an omitted count means one line.
const HUNK_HEADER_RE = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

function headerPath(line: string): string {
    return line.slice(4).replace(/^"?[ab]\//, '').replace(/"$/, '');
}

type Side = 'old' | 'new' | 'both';

/**
 * Walk a unified diff (or a hunk fragment with no headers) and report every
 * content line to `onLine`. Shared by the old/new reconstruction and the
 * +/− counters so both agree on what is a header and what is content.
 *
 * Hunk state decides what a "--- " / "+++ " line is: while the hunk header's
 * counts say the old (new) side is still owed lines, a "-"-prefixed
 * ("+"-prefixed) line is content even when it looks like "--- a/literal"
 * (#108, #274); once the counts are spent — or before any hunk opened — it is
 * the next file's header. A fragment without an "@@" header has no counts
 * and falls back to the unmistakable a/ b/ /dev/null header shape.
 */
function walkUnifiedDiff(
    unifiedDiff: string,
    onLine: (side: Side, content: string) => void,
    onHeader?: (oldPath: string | undefined, newPath: string | undefined) => void,
    onNoNewline?: (side: Side) => void,
): void {
    const lines = unifiedDiff.split('\n');
    // A '\n'-terminated patch splits into a trailing "" that is transport,
    // not a blank content line (#423).
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    let inHunk = false;
    // Lines the open hunk still owes on each side; -1 when unknown (no "@@").
    let oldLeft = -1;
    let newLeft = -1;
    let lastSide: Side | null = null;
    let oldPath: string | undefined;
    let newPath: string | undefined;

    const isFileHeader = (line: string): boolean => {
        if (!inHunk) return true;
        if (oldLeft >= 0 && newLeft >= 0) {
            return line.startsWith('-') ? oldLeft === 0 : newLeft === 0;
        }
        return FILE_HEADER_RE.test(line);
    };
    const consume = (n: number): number => (n > 0 ? n - 1 : n);

    for (const line of lines) {
        if ((line.startsWith('--- ') || line.startsWith('+++ ')) && isFileHeader(line)) {
            inHunk = false;
            if (line.startsWith('--- ')) {
                oldPath = headerPath(line);
                newPath = undefined;
            } else {
                newPath = headerPath(line);
                onHeader?.(oldPath, newPath);
            }
            continue;
        }

        if (line.startsWith('diff --git')) {
            inHunk = false;
            continue;
        }

        if (
            !inHunk && (
                line.startsWith('index ') ||
                line.startsWith('---') ||
                line.startsWith('new file mode') ||
                line.startsWith('deleted file mode') ||
                line.startsWith('similarity index ') ||
                line.startsWith('rename from ') ||
                line.startsWith('rename to ')
            )
        ) {
            continue;
        }

        if (line.startsWith('@@')) {
            inHunk = true;
            lastSide = null;
            const hunk = HUNK_HEADER_RE.exec(line);
            oldLeft = hunk ? (hunk[1] === undefined ? 1 : Number(hunk[1])) : -1;
            newLeft = hunk ? (hunk[2] === undefined ? 1 : Number(hunk[2])) : -1;
            continue;
        }

        if (!inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
            inHunk = true;
            oldLeft = -1;
            newLeft = -1;
        }

        if (!inHunk) {
            continue;
        }

        if (line === NO_NEWLINE_MARKER) {
            if (lastSide) onNoNewline?.(lastSide);
            continue;
        }

        if (line.startsWith('+')) {
            lastSide = 'new';
            newLeft = consume(newLeft);
            onLine('new', line.substring(1));
        } else if (line.startsWith('-')) {
            lastSide = 'old';
            oldLeft = consume(oldLeft);
            onLine('old', line.substring(1));
        } else if (line.startsWith(' ')) {
            lastSide = 'both';
            oldLeft = consume(oldLeft);
            newLeft = consume(newLeft);
            onLine('both', line.substring(1));
        } else if (line === '') {
            // A blank context line whose leading space was trimmed in transit.
            lastSide = 'both';
            oldLeft = consume(oldLeft);
            newLeft = consume(newLeft);
            onLine('both', '');
        }
    }
}

/** The side's real text: every hunk line is '\n'-terminated unless the marker said otherwise. */
function sideText(lines: string[], noNewline: boolean): string {
    if (lines.length === 0) return '';
    return lines.join('\n') + (noNewline ? '' : '\n');
}

/**
 * Parse a unified diff or diff hunk fragment into old/new file contents.
 *
 * Every hunk line stands for a '\n'-terminated line unless a "\ No newline
 * at end of file" marker follows it (the marker applies to the side of the
 * line before it). For display the shared final newline is dropped from
 * both sides — nobody needs to see it — and a side facing an EMPTY other
 * side drops it too. A side keeps its newline when dropping it would leave
 * nothing (a new file of exactly one newline reconstructed as "", i.e. a
 * no-op) or when the other side is unterminated: then the newline IS the
 * edit ("hello" → "hello\n") that the reconstruction used to erase (#423).
 */
export function parseUnifiedDiff(unifiedDiff: string): ParsedUnifiedDiff {
    const oldLines: string[] = [];
    const newLines: string[] = [];
    let fileName: string | undefined;
    let oldNoNewline = false;
    let newNoNewline = false;

    walkUnifiedDiff(
        unifiedDiff,
        (side, content) => {
            if (side !== 'new') oldLines.push(content);
            if (side !== 'old') newLines.push(content);
        },
        (oldPath, newPath) => {
            // A deleted file's new side is /dev/null; its name is on the old
            // side — the parser used to report "/dev/null" as the file (#424).
            const name = newPath && newPath !== DEV_NULL ? newPath : oldPath && oldPath !== DEV_NULL ? oldPath : undefined;
            if (name !== undefined) fileName = name;
        },
        (side) => {
            if (side !== 'new') oldNoNewline = true;
            if (side !== 'old') newNoNewline = true;
        },
    );

    const oldText = sideText(oldLines, oldNoNewline);
    const newText = sideText(newLines, newNoNewline);
    // Can lose its final newline without vanishing.
    const droppable = (text: string) => text.length > 1 && text.endsWith('\n');
    const dropOld = droppable(oldText) && (droppable(newText) || newText === '');
    const dropNew = droppable(newText) && (droppable(oldText) || oldText === '');

    return {
        oldText: dropOld ? oldText.slice(0, -1) : oldText,
        newText: dropNew ? newText.slice(0, -1) : newText,
        fileName,
    };
}

/**
 * Added/removed line counts of a patch, by parser state rather than by prefix:
 * a removed "--before" / added "++after" pair counted as +0 −0 when every
 * "---"/"+++" line was taken for a file header (#274).
 */
export function countUnifiedDiffChanges(unifiedDiff: string): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    walkUnifiedDiff(unifiedDiff, (side) => {
        if (side === 'new') added++;
        else if (side === 'old') removed++;
    });
    return { added, removed };
}
