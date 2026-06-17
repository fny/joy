import * as React from 'react';
import { apiSocket } from '@/sync/apiSocket';
import { useActiveInterval } from './useActiveInterval';

// Mirrors joy-tmux Session.queueState(). The queue holds messages the user
// lined up while Claude was busy; the daemon dispatches them one at a time
// (see Session #maybeDrainQueue). `inFlight` is the message typed but not yet
// confirmed; `paused` means a dispatch failed and auto-drain is halted.
export interface QueuedMessage { id: string; text: string; createdAt: number; }
export interface JoyQueueState { queue: QueuedMessage[]; inFlight: string | null; paused: boolean; }

const EMPTY: JoyQueueState = { queue: [], inFlight: null, paused: false };

export function useJoyQueue(
    machineId: string | undefined,
    joySessionId: string | undefined,
    active: boolean,
) {
    const [state, setState] = React.useState<JoyQueueState>(EMPTY);

    const apply = React.useCallback((r: (JoyQueueState & { error?: string }) | undefined) => {
        if (r && !r.error) setState({ queue: r.queue ?? [], inFlight: r.inFlight ?? null, paused: !!r.paused });
    }, []);

    const refresh = React.useCallback(async () => {
        if (!machineId || !joySessionId) return;
        try {
            apply(await apiSocket.machineRPC(machineId, 'joy-queue-list', { id: joySessionId }) as any);
        } catch { /* poll best-effort */ }
    }, [machineId, joySessionId, apply]);

    // Poll lightly while the session is active so the strip stays live as the
    // daemon drains items — but only while the screen is focused AND the app is
    // foregrounded, so a locked phone doesn't keep hitting the daemon (battery).
    useActiveInterval(() => void refresh(), 1200, active && !!machineId && !!joySessionId);

    const call = React.useCallback(async (rpc: string, params: Record<string, unknown>) => {
        if (!machineId || !joySessionId) return;
        try {
            apply(await apiSocket.machineRPC(machineId, rpc, { id: joySessionId, ...params }) as any);
        } catch { /* best-effort; next poll reconciles */ }
    }, [machineId, joySessionId, apply]);

    return {
        ...state,
        refresh,
        add: (text: string) => call('joy-queue-add', { text }),
        edit: (qid: string, text: string) => call('joy-queue-edit', { qid, text }),
        cancel: (qid: string) => call('joy-queue-cancel', { qid }),
        reorder: (qid: string, toIndex: number) => call('joy-queue-reorder', { qid, toIndex }),
        resume: () => call('joy-queue-resume', {}),
    };
}
