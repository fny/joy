/**
 * The Changes screen's view of the project's file list.
 *
 * Stale-while-revalidate through the git-status RESOURCE (sync/
 * gitStatusResource): on first visit (nothing cached) isLoading is true while
 * the read runs; on later visits the cached list renders instantly and a
 * refresh runs in the background, re-rendering only if the daemon's answer
 * differs. Every writer of that list (this screen, the session sidebar, a
 * session becoming visible) goes through the same resource, so a slow older
 * read can never overwrite a fresher one (#316), a failed read keeps the last
 * good list, and only the daemon's explicit "not a repository" clears it.
 *
 * The resource's four states reach the screen as `state`: no answer yet,
 * a failed/unavailable read with nothing cached (an error with Retry — NOT
 * "not a repository"), the daemon's explicit not-a-repository, and a list
 * (with `stale` set when the newest revalidation failed).
 */
import { useGitStatusResource } from '@/sync/gitStatusResource';
import type { GitStatusFiles } from '@/sync/gitStatusModel';

export type GitStatusScreenState =
    /** Nothing known yet: the first read is running, or the project key has not appeared. */
    | { kind: 'loading' }
    /** The newest read failed or could not run and nothing is cached. */
    | { kind: 'failed'; reason: string }
    /** The daemon said so explicitly. */
    | { kind: 'not-repo' }
    /** The last good list; `stale` is the newest revalidation's failure, if any. */
    | { kind: 'ready'; files: GitStatusFiles; stale: string | null };

/** Pure projection of the resource entry (tested in isolation). */
export function gitStatusScreenState(view: {
    hasData: boolean;
    files: GitStatusFiles | null;
    error: string | null;
    unavailable: string | null;
}): GitStatusScreenState {
    const failure = view.error ?? view.unavailable;
    if (!view.hasData) return failure ? { kind: 'failed', reason: failure } : { kind: 'loading' };
    if (view.files === null) return { kind: 'not-repo' };
    return { kind: 'ready', files: view.files, stale: failure };
}

export function useGitStatusFiles(sessionId: string) {
    // Refresh on mount and every time the screen is focused.
    const view = useGitStatusResource(sessionId, { refetchOnScreenFocus: 'always' });
    return {
        data: view.files,
        // Only show loading spinner when there's no cached data yet
        isLoading: view.isLoading,
        /** The changed list's version: when the status data last changed. */
        revision: view.dataUpdatedAt,
        state: gitStatusScreenState({ hasData: view.entry.hasData, files: view.files, error: view.error, unavailable: view.unavailable }),
        refresh: view.refresh,
    };
}
