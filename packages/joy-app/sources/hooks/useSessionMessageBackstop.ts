import * as React from 'react';
import { sync } from '@/sync/sync';

// Bounded missed-event repair loop for the OPEN session.
//
// socket `update` / `ephemeral` events can be silently dropped — a stalled
// transport that never fires a reconnect edge, or a backgrounded tab. When that
// happens the open chat freezes mid-turn (no streamed message, stale thinking)
// until it's manually remounted. Reconnect/foreground refetches (see sync.ts)
// cover the lifecycle edges; this covers the remaining gap codex flagged: a
// FOREGROUND tab whose socket silently stops delivering with no status change.
//
// While the user is looking at a LIVE turn — Claude thinking, OR a message sent
// in the last ~90s (the send trigger is independent of `thinking` precisely
// because a missed turn-start ephemeral is one of the things we're repairing) —
// this forward-syncs the session every 10–15s (jittered), then stops the instant
// the turn goes idle. This is a repair loop, NOT data polling: it runs only
// during an active turn the user is watching, and forward-sync returns nothing
// when already current.
const TICK_MIN_MS = 10_000;
const TICK_JITTER_MS = 5_000;
const RECENT_SEND_WINDOW_MS = 90_000;

export function useSessionMessageBackstop(
    sessionId: string,
    thinking: boolean,
    lastUserSentAt: number | null,
) {
    React.useEffect(() => {
        const isActive = () =>
            thinking || (lastUserSentAt != null && Date.now() - lastUserSentAt < RECENT_SEND_WINDOW_MS);
        if (!isActive()) return;

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout>;
        const schedule = () => {
            const delay = TICK_MIN_MS + Math.random() * TICK_JITTER_MS;
            timer = setTimeout(() => {
                if (cancelled) return;
                if (!isActive()) return; // turn went idle → stop until a new trigger
                sync.backstopSyncSession(sessionId);
                schedule();
            }, delay);
        };
        schedule();
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [sessionId, thinking, lastUserSentAt]);
}
