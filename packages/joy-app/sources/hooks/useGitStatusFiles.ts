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
import { gitStatusRefreshScope, startGitStatusRefresh } from '@/sync/gitStatusFiles';
import { useSession, useSessionGitStatusFiles } from '@/sync/storage';

// Publication goes through the module-level scope in gitStatusFiles that the
// sidebar shares: the screen that started a stale request may have unmounted
// by the time it resolves, and any later writer must still outrank it. This
// instance remembers the generation IT minted so blur/unmount retires only
// its own refresh — retiring the whole project used to cancel a sibling
// screen's in-flight refresh and leave it fetching forever (#316).
export function useGitStatusFiles(sessionId: string) {
    const cached = useSessionGitStatusFiles(sessionId);
    const [isFetching, setIsFetching] = React.useState(false);
    const ownGen = React.useRef<number | null>(null);
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
        const { gen, settled } = startGitStatusRefresh(sessionId, pathKey);
        ownGen.current = gen;
        setIsFetching(true);
        await settled; // publication (or not) is decided inside the shared scope
        // The spinner tracks THIS instance's latest request: clear it when that
        // request settled, whether or not it was allowed to publish — a refresh
        // the sidebar superseded must not leave the screen fetching forever.
        if (ownGen.current === gen) setIsFetching(false);
    }, [sessionId, pathKey]);

    // Refresh on mount and every time the screen is focused; on blur/unmount
    // retire the generation THIS instance minted so its in-flight refresh
    // cannot publish from a screen that is no longer showing the list, while a
    // sibling writer's newer refresh stays current (#316).
    useFocusEffect(
        React.useCallback(() => {
            refresh();
            return () => {
                if (pathKey && ownGen.current !== null) gitStatusRefreshScope.retire(pathKey, ownGen.current);
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
