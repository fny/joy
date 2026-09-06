/**
 * Identity of a file's diff in the all-files view: what must change for the
 * diff to be fetched again.
 *
 * git status carries no content hash or mtime, so status + line counts alone
 * were used — and an edit that kept them (an untracked file's contents, a
 * tracked +1/-1 rewritten as another +1/-1) never refreshed, nor did a later
 * change to the repository (#199). Two things fix that:
 *  - EVERY status row for the path takes part (staged AND unstaged), so a
 *    change to the unstaged portion of a partially-staged file is seen even
 *    though the view lists the path once;
 *  - a repository-change `revision` — bumped each time the store publishes a
 *    different status list — is part of the signature, so any change to the
 *    working tree that git reported invalidates every diff; a fetch that
 *    returns identical content keeps its previous result object.
 */
export type DiffRow = {
    status: string;
    isStaged: boolean;
    lines: 'unavailable' | { added: number; removed: number };
};

export function diffSignature(rows: readonly DiffRow[], revision: number): string {
    const parts = rows
        .map((r) => `${r.status}|${r.isStaged ? 1 : 0}|${r.lines === 'unavailable' ? 'u' : `${r.lines.added}/${r.lines.removed}`}`)
        .sort();
    return `r${revision}:${parts.join(';')}`;
}

/** Group status rows by identity path, preserving order within a path. */
export function rowsByPath<T extends { fullPath: string }>(rows: readonly T[]): Map<string, T[]> {
    const map = new Map<string, T[]>();
    for (const row of rows) {
        const list = map.get(row.fullPath);
        if (list) list.push(row);
        else map.set(row.fullPath, [row]);
    }
    return map;
}
