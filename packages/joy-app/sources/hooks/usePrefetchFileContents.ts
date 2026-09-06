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
 * Infinity)` reads a key only when nothing is cached and coalesces with a
 * read already in flight, and a foreground read (`refresh`) or a save
 * (`setData`) of the same key supersedes whatever this prefetch started
 * earlier — an older prefetch can no longer land over what the user just did
 * (#325). No second gate is needed.
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

/** Warm the resources for `targets`; stops issuing new reads once cancelled. */
export async function runPrefetch(
    sessionId: string,
    targets: readonly PrefetchTarget[],
    isCancelled: () => boolean = () => false,
    concurrency: number = MAX_CONCURRENCY,
): Promise<void> {
    let i = 0;
    const worker = async (): Promise<void> => {
        while (!isCancelled()) {
            const target = targets[i++];
            if (!target) return;
            await Promise.all([
                resources.ensure(fileContentsSpec(sessionId, target.absolutePath), { staleTime: Infinity }),
                target.diffPath
                    ? resources.ensure(gitDiffSpec(sessionId, target.diffPath), { staleTime: Infinity })
                    : Promise.resolve(),
            ]);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
}

export function usePrefetchFileContents(sessionId: string, gitStatusFiles: GitStatusFiles | null) {
    React.useEffect(() => {
        if (!gitStatusFiles) return;
        const sessionPath = storage.getState().sessions[sessionId]?.metadata?.path;
        if (!sessionPath) return;
        const targets = prefetchTargets([...gitStatusFiles.stagedFiles, ...gitStatusFiles.unstagedFiles], sessionPath);
        if (targets.length === 0) return;
        let cancelled = false;
        void runPrefetch(sessionId, targets, () => cancelled);
        return () => { cancelled = true; };
    }, [sessionId, gitStatusFiles]);
}
