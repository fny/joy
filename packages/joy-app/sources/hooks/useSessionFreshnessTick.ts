import * as React from 'react';
import { storage } from '@/sync/storage';
import { msUntilNextSessionStale } from '@/sync/sessionLiveness';

/**
 * Re-derive the session list the moment a session crosses the freshness
 * window. isFresh() is a pure clock check, and the list rows (online colour,
 * active grouping) are built when the store changes — so a session whose
 * daemon went quiet stayed "online" until some unrelated update rebuilt the
 * list. One timeout, armed for the earliest currently-fresh session's expiry
 * (msUntilNextSessionStale), rebuilds the list on time; a heartbeat that
 * lands first changes activeAt, which re-arms it. The same shape as
 * useMachinesOnlineTick (#180/#323), for sessions.
 */
export function useSessionFreshnessTick(): void {
    // Only the activeAt values matter; a selector over them keeps this hook
    // from re-running on every message.
    const sessions = storage((s) => s.sessions);
    React.useEffect(() => {
        const next = msUntilNextSessionStale(Object.values(sessions), Date.now());
        if (next === null) return;
        const t = setTimeout(() => storage.getState().refreshSessionListViewData(), next + 100);
        return () => clearTimeout(t);
    }, [sessions]);
}
