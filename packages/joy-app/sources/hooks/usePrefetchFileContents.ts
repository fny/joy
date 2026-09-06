/**
 * Impression-based prefetch for file contents.
 *
 * When the file list is rendered, this hook warms the file-contents and
 * per-path diff RESOURCES (sync/fileContents) for every openable, non-binary
 * file that is not cached yet, so tapping into a file shows content
 * instantly. Limited concurrency (3 at a time) keeps the daemon's queue
 * short. Deleted, binary and unaddressable rows are skipped.
 *
 * Ownership is the resource's, not this hook's: `ensure(…, staleTime:
 * Infinity)` reads a key only when nothing is cached FOR THIS REVISION and
 * coalesces with a read already in flight for it, and a foreground read
 * (`refresh`) or a save (`setData`) of the same key supersedes whatever
 * this prefetch started earlier — an older prefetch can no longer land over
 * what the user just did (#325). No second gate is needed.
 *
 * The revision is the changed list's (the git status data's update stamp):
 * an impression that replaces one cancelled mid-read after the repository
 * changed carries a newer revision, so the store serves it with one
 * trailing read once the old read settles instead of handing it the
 * obsolete contents; an impression at the same revision coalesces.
 */

import * as React from 'react';
import { storage } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { isBinaryPath } from '@/utils/binaryFile';
import { resources } from '@/sync/resource';
import { fileContentsSpec, gitDiffSpec } from '@/sync/fileContents';
import type { GitFileStatus, GitStatusFiles } from '@/sync/gitStatusModel';

export interface PrefetchTarget {
    /** Absolute path the daemon accepts (the file resource's identity). */
    absolutePath: string;
    /** Repo-relative path for git/diff, when inside the session root. */
    diffPath: string | null;
}

/**
 * Which rows are worth reading: openable (not deleted), text (by extension),
 * ADDRESSABLE (a non-UTF-8 name has no path the daemon accepts — its
 * identity key must never reach a file operation) and listed once.
 */
export function prefetchTargets(files: readonly GitFileStatus[], sessionPath: string): PrefetchTarget[] {
    const out: PrefetchTarget[] = [];
    const seen = new Set<string>();
    for (const file of files) {
        if (file.status === 'deleted' || file.unaddressable || isBinaryPath(file.fullPath)) continue;
        if (seen.has(file.fullPath)) continue;
        seen.add(file.fullPath);
        const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
        const absolutePath = resolved?.absolutePath ?? file.fullPath;
        const diffPath = resolved?.withinSessionRoot && resolved.relativePath !== '.' ? resolved.relativePath : null;
        out.push({ absolutePath, diffPath });
    }
    return out;
}

const MAX_CONCURRENCY = 3;

/** Warm the resources for `targets` at `revision` (the changed list's);
 *  stops issuing new reads once cancelled. */
export async function runPrefetch(
    sessionId: string,
    targets: readonly PrefetchTarget[],
    isCancelled: () => boolean = () => false,
    concurrency: number = MAX_CONCURRENCY,
    revision?: string,
): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
        while (!isCancelled()) {
            const target = targets[i++];
            if (!target) return;
            await Promise.all([
                resources.ensure(fileContentsSpec(sessionId, target.absolutePath, revision), { staleTime: Infinity }),
                target.diffPath
                    ? resources.ensure(gitDiffSpec(sessionId, target.diffPath, {}, revision), { staleTime: Infinity })
                    : Promise.resolve(),
            ]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
}

/** `revision`: when the changed list last changed (git status `dataUpdatedAt`);
 *  omitted, every impression coalesces with whatever is cached or in flight. */
export function usePrefetchFileContents(sessionId: string, gitStatusFiles: GitStatusFiles | null, revision?: number) {
    React.useEffect(() => {
        if (!gitStatusFiles) return;
        const sessionPath = storage.getState().sessions[sessionId]?.metadata?.path;
        if (!sessionPath) return;
        const targets = prefetchTargets([...gitStatusFiles.stagedFiles, ...gitStatusFiles.unstagedFiles], sessionPath);
        if (targets.length === 0) return;
        let cancelled = false;
        void runPrefetch(sessionId, targets, () => cancelled, MAX_CONCURRENCY, revision !== undefined ? String(revision) : undefined);
        return () => { cancelled = true; };
    }, [sessionId, gitStatusFiles, revision]);
}
