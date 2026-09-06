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
// on every line (#108). A header is recognised when no hunk is open, or when
// the line has the unmistakable a/ b/ /dev/null form (a new file's headers in
// a multi-file diff without `diff --git` lines).
const FILE_HEADER_RE = /^(---|\+\+\+) (?:"?[ab]\/|\/dev\/null)/;

function headerPath(line: string): string {
    return line.slice(4).replace(/^"?[ab]\//, '').replace(/"$/, '');
}

type Side = 'old' | 'new' | 'both';

/**
 * Walk a unified diff (or a hunk fragment with no headers) and report every
 * content line to `onLine`. Shared by the old/new reconstruction and the
 * +/− counters so both agree on what is a header and what is content.
 */
function walkUnifiedDiff(
    unifiedDiff: string,
    onLine: (side: Side, content: string) => void,
    onHeader?: (oldPath: string | undefined, newPath: string | undefined) => void,
    onNoNewline?: (side: Side) => void,
): void {
    const lines = unifiedDiff.split('\n');
    // A '\n'-terminated patch splits into a trailing "" that is transport,
    // not a blank content line: it appended an empty line to both files and
    // hid a real final-newline-only edit (#423).
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();

    let inHunk = false;
    let lastSide: Side | null = null;
    let oldPath: string | undefined;
    let newPath: string | undefined;

    for (const line of lines) {
        const isHeaderShape = FILE_HEADER_RE.test(line);
        if ((!inHunk || isHeaderShape) && (line.startsWith('--- ') || line.startsWith('+++ '))) {
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
            continue;
        }

        if (!inHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
            inHunk = true;
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
            onLine('new', line.substring(1));
        } else if (line.startsWith('-')) {
            lastSide = 'old';
            onLine('old', line.substring(1));
        } else if (line.startsWith(' ')) {
            lastSide = 'both';
            onLine('both', line.substring(1));
        } else if (line === '') {
            // A blank context line whose leading space was trimmed in transit.
            lastSide = 'both';
            onLine('both', '');
        }
    }
}

/**
 * Parse a unified diff or diff hunk fragment into old/new file contents.
 *
 * A "\ No newline at end of file" marker applies to the side of the line
 * before it. Only when exactly one side carries the marker does the other
 * side get its trailing "\n": that is the edit ("hello" → "hello\n") the
 * reconstruction used to erase (#423). With no marker on either side the
 * texts end without a newline, as before.
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

    const oldTrailing = !oldNoNewline && newNoNewline && oldLines.length > 0 ? '\n' : '';
    const newTrailing = !newNoNewline && oldNoNewline && newLines.length > 0 ? '\n' : '';

    return {
        oldText: oldLines.join('\n') + oldTrailing,
        newText: newLines.join('\n') + newTrailing,
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
