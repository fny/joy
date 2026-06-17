import * as React from 'react';
import { apiSocket } from '@/sync/apiSocket';

// Mirrors joy-tmux Session.queueState(). The queue holds messages the user
// lined up while Claude was busy; the daemon dispatches them one at a time
// (see Session #maybeDrainQueue). `inFlight` is the message typed but not yet
// confirmed; `paused` means a dispatch failed and auto-drain is halted.
export interface QueuedMessage { id: string; text: string; createdAt: number; }
export interface JoyQueueState { queue: QueuedMessage[]; inFlight: string | null; paused: boolean; }

const EMPTY: JoyQueueState = { queue: [], inFlight: null, paused: false };

/**
 * Queue state is PUSHED by the daemon via session metadata (`joy__queue`), so
 * there is no polling — `metaQueue` comes straight from the (reactive) relay
 * session and updates live. Mutations go out as machineRPCs; we don't apply
 * their result locally — the daemon re-pushes `joy__queue` and the metadata
 * update reflects it (resync-safe across reconnects, since metadata is stored
 * server-side).
 */
export function useJoyQueue(
    machineId: string | undefined,
    joySessionId: string | undefined,
    metaQueue: JoyQueueState | null | undefined,
) {
    const state = metaQueue ?? EMPTY;

    const call = React.useCallback(async (rpc: string, params: Record<string, unknown>) => {
        if (!machineId || !joySessionId) return;
        try {
            await apiSocket.machineRPC(machineId, rpc, { id: joySessionId, ...params });
        } catch { /* best-effort; the daemon re-pushes joy__queue metadata */ }
    }, [machineId, joySessionId]);

    return {
        ...state,
        add: (text: string) => call('joy-queue-add', { text }),
        edit: (qid: string, text: string) => call('joy-queue-edit', { qid, text }),
        cancel: (qid: string) => call('joy-queue-cancel', { qid }),
        reorder: (qid: string, toIndex: number) => call('joy-queue-reorder', { qid, toIndex }),
        resume: () => call('joy-queue-resume', {}),
    };
}
