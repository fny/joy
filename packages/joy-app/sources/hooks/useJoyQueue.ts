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

/** What the daemon's queue routes answer with: `ok` on success, an `error`
 *  string otherwise (the body may also be empty or non-JSON). */
export interface QueueMutationReply { ok?: boolean; error?: string }

/**
 * Decide whether a daemon queue mutation actually happened. Returns the
 * failure reason, or null when the daemon acknowledged it.
 *
 * tunnelJson never throws on a daemon status code — a 409 ("that item was
 * already dispatched"), a 500 with an empty body and a `{ ok: false }` all
 * came back as an ordinary resolved value, so cancel/edit/move "succeeded"
 * in the UI while the original instruction stayed eligible to run (#321).
 * Only an explicit 2xx + `ok: true` counts.
 */
export function queueMutationError(status: number, data: QueueMutationReply | null): string | null {
    if (status >= 200 && status < 300 && data?.ok === true) return null;
    if (data?.error) return data.error;
    // The daemon answers 200 + `ok: false` when the qid is no longer in its
    // queue (already dispatched, or removed from another device).
    if (data?.ok === false) return 'queue item no longer queued';
    return `HTTP ${status}`;
}

/**
 * Queue state is PUSHED by the daemon via session metadata (`joy__queue`), so
 * there is no polling — `metaQueue` comes straight from the (reactive) relay
 * session and updates live. Mutations go out as machineRPCs; we don't apply
 * their result locally — the daemon re-pushes `joy__queue` and the metadata
 * update reflects it (resync-safe across reconnects, since metadata is stored
 * server-side).
 *
 * Every mutation REJECTS when it did not land (no machine context, transport
 * failure, non-success daemon reply) so a caller can keep its edit, restore
 * the text, or tell the user — a resolved promise means the daemon applied
 * it (#321). Metadata alone cannot say that: it only reflects successes.
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
    const call = React.useCallback(async (method: string, sub: string, body?: Record<string, unknown>): Promise<void> => {
        // A missing session/machine id is a failure too, not a silent no-op:
        // the caller (steer, remove) is about to act as if the item were
        // cancelled (#321).
        if (!machineId || !joySessionId) throw new Error('queue op dropped: session metadata incomplete');
        const ctx = sync.machineCtxFor(machineId, joySessionId);
        if (!ctx) throw new Error('queue op dropped: no machine context');
        const { status, data } = await tunnelJson<QueueMutationReply>({
            relayUrl: ctx.relayUrl, accountToken: ctx.accountToken, machineKey: ctx.machineKey,
            machineId: ctx.machineId, method, path: `/v2/sessions/${joySessionId}/queue${sub}`, json: body,
        });
        const error = queueMutationError(status, data);
        if (error) throw new Error(error);
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
