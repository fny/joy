import * as React from 'react';
import { sync } from '@/sync/sync';
import { tunnelJson } from '@/sync/v2/tunnel';

// Mirrors joy-tmux Session.queueState(). The queue holds messages the user
// lined up while Claude was busy; the daemon dispatches them one at a time
// (see Session #maybeDrainQueue). `inFlight` is the message typed but not yet
// confirmed; `paused` means a dispatch failed and auto-drain is halted.
export interface QueuedMessage { id: string; text: string; createdAt: number; }
export type QueuePauseReason = 'input_dirty' | 'dispatch_timeout' | 'dispatch_mismatch' | 'dispatch_failed';
export interface JoyQueueState { queue: QueuedMessage[]; hidden?: QueuedMessage[]; pendingCount?: number; inFlight: string | null; paused: boolean; pauseReason?: QueuePauseReason; }

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

    // These operate on the DAEMON's local dispatch queue — qids come from the
    // daemon's joy__queue metadata (a different queue from the relay's durable
    // v2 turn queue). Mutations travel the sealed tunnel to the daemon's
    // /v2/sessions/:id/queue routes.
    const call = React.useCallback(async (method: string, sub: string, body?: Record<string, unknown>) => {
        if (!machineId || !joySessionId) return;
        try {
            const ctx = machineId && joySessionId ? sync.machineCtxFor(machineId, joySessionId) : null;
            if (!ctx) { console.error('[v2] queue op dropped: no machine context'); return; }
            await tunnelJson({
                relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
                machineId: ctx.machineId, method, path: `/v2/sessions/${joySessionId}/queue${sub}`, json: body,
            });
        } catch { /* best-effort; the daemon re-pushes joy__queue metadata */ }
    }, [machineId, joySessionId]);

    return {
        ...state,
        add: (text: string) => call('POST', '', { text }),
        edit: (qid: string, text: string) => call('PATCH', `/${qid}`, { text }),
        cancel: (qid: string) => call('DELETE', `/${qid}`),
        reorder: (qid: string, toIndex: number) => call('POST', `/${qid}/move`, { toIndex }),
        resume: () => call('POST', '/resume', {}),
    };
}
