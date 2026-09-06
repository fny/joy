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
 */
import { useGitStatusResource } from '@/sync/gitStatusResource';

export function useGitStatusFiles(sessionId: string) {
    // Refresh on mount and every time the screen is focused.
    const { files, isLoading } = useGitStatusResource(sessionId, { refetchOnScreenFocus: 'always' });
    return {
        data: files,
        // Only show loading spinner when there's no cached data yet
        isLoading,
    };
}
