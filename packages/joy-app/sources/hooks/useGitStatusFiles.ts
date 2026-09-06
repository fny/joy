/**
 * Stale-while-revalidate hook for git status files.
 *
 * On first visit (no cache): shows isLoading=true while fetching.
 * On subsequent visits (e.g. returning from file view): renders cached data
 * instantly from the Zustand store, refreshes silently in the background.
 * The component only re-renders if the fetched data actually differs from cache.
 *
 * Two rules protect the shared per-project cache:
 *  - latest-wins: a refresh publishes only if no newer refresh for the same
 *    project started after it — a slow first fetch used to overwrite the
 *    result of a later refocus fetch with older files (#316);
 *  - keep the last good value: a refresh that FAILS (daemon unreachable, a
 *    diff request erroring) leaves the last successful list in place instead
 *    of replacing it with "not a git repository".
 */

import * as React from 'react';
import { useFocusEffect } from 'expo-router';
import { fetchGitStatusFiles } from '@/sync/gitStatusFiles';
import { createRefreshScope } from '@/sync/gitStatusModel';
import { storage, useSession, useSessionGitStatusFiles } from '@/sync/storage';

// Refresh generation per project key, MODULE-level: the screen that started
// the stale request may have unmounted by the time it resolves, and a fresh
// hook instance must still be able to outrank it. The focus effect retires
// the generation on blur/unmount, so a refresh that completes after the
// screen went away publishes nothing (#316).
const refreshScope = createRefreshScope();

export function useGitStatusFiles(sessionId: string) {
    const cached = useSessionGitStatusFiles(sessionId);
    const [isFetching, setIsFetching] = React.useState(false);
    // On a cold load the screen mounts BEFORE sessions hydrate, so the project
    // key does not exist yet. Track it reactively and key the refresh on it:
    // otherwise the focus effect fires once against an unhydrated store, bails,
    // and the screen shows "not a git repository" until the user navigates away
    // and back.
    const session = useSession(sessionId);
    const pathKey = session?.metadata?.machineId && session?.metadata?.path
        ? `${session.metadata.machineId}:${session.metadata.path}`
        : null;

    const refresh = React.useCallback(async () => {
        if (!pathKey) return;
        const myGen = refreshScope.begin(pathKey);
        setIsFetching(true);
        try {
            const result = await fetchGitStatusFiles(sessionId);
            if (!refreshScope.isCurrent(pathKey, myGen)) return; // superseded by a newer refresh, or the screen blurred (#316)
            if (result.kind === 'ok') {
                storage.getState().applyGitStatusFiles(pathKey, result.files);
            } else if (result.kind === 'not-repo') {
                storage.getState().applyGitStatusFiles(pathKey, null); // authoritative: nothing to list
            } else {
                // Failed read: keep whatever was last listed successfully.
                console.warn(`[git] status refresh unavailable for ${pathKey}, keeping last result: ${result.error}`);
            }
        } catch (error) {
            console.error('Failed to load git status files:', error);
        } finally {
            if (refreshScope.isCurrent(pathKey, myGen)) setIsFetching(false);
        }
    }, [sessionId, pathKey]);

    // Refresh on mount and every time the screen is focused; on blur/unmount
    // retire the project's generation so the in-flight refresh cannot publish
    // into the cache from a screen that is no longer showing it (#316).
    useFocusEffect(
        React.useCallback(() => {
            refresh();
            return () => {
                if (pathKey) refreshScope.retire(pathKey);
                setIsFetching(false);
            };
        }, [refresh, pathKey])
    );

    return {
        data: cached,
        // Only show loading spinner when there's no cached data yet
        isLoading: !cached && isFetching,
    };
}
