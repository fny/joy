import * as React from 'react';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useDrafts, useDraftQueueStore, draftReason } from './draftQueue';
import { MAX_AUTO_ATTEMPTS, cancelRelease, useCancelPending } from './draftQueueRelease';
import { QueueStack, type QueueRowModel } from './QueueStack';
import type { useJoyQueue } from '@/hooks/useJoyQueue';
import { useDelayedAppearance } from '@/hooks/useDelayedAppearance';

type Queue = ReturnType<typeof useJoyQueue>;

// Every app send transits the daemon's dispatch queue for ~a second even when
// the agent is idle; items younger than this are in transit, not held, and
// rendering them flashed "waiting" on every send. Anything older genuinely is.
const APPEAR_MS = 2500;

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// "Waiting": ONE list of everything you sent that has not reached the agent,
// regardless of where it is held —
//   · app-held (a turn was running when you sent; released when it ends),
//   · the daemon's dispatch queue (delivered next; edit/cancel/steer via the
//     daemon), including app-sent messages whose bubbles already exist.
// These were two strips with two names ("waiting to send" and "queued"), which
// is one distinction too many for the person looking at them.
export const WaitingStack = React.memo(function WaitingStack({ sessionId, queue }: { sessionId: string; queue: Queue }) {
    const all = useDrafts(sessionId);
    const held = React.useMemo(() => all.filter((d) => draftReason(d) === 'busy'), [all]);
    const update = useDraftQueueStore((s) => s.update);
    const retryRelease = useDraftQueueStore((s) => s.retryRelease);
    const cancelPending = useCancelPending(sessionId);

    const daemonVisible = useDelayedAppearance(queue.queue, APPEAR_MS, queue.paused);
    const daemonHidden = useDelayedAppearance(queue.hidden ?? [], APPEAR_MS, queue.paused);

    // Daemon queue mutations reject when they did not land (#321); a failure
    // is shown, never swallowed — the item is still queued and will run.
    const daemonOp = React.useCallback((op: Promise<void>) => {
        op.catch((e) => Modal.alert(t('common.error'), errorText(e)));
    }, []);

    // Steer = cancel the queued copy, then deliver the text into the running
    // turn. The cancel must be CONFIRMED before the send, and the text is held
    // until the replacement send is accepted: with both fire-and-forget, a
    // cancel that landed followed by a send that failed (relay POST refused,
    // content key unavailable) lost the instruction with no trace (#135). On
    // a failed send the text goes back into the app-held queue with the error,
    // where it is visible, editable and retried.
    const steer = React.useCallback(async (id: string, text: string) => {
        try {
            await queue.cancel(id);
        } catch (e) {
            Modal.alert(t('common.error'), errorText(e));
            return; // still queued on the daemon; nothing was lost
        }
        let reason: string;
        try {
            const res = await sync.sendMessage(sessionId, `/steer ${text}`, { source: 'chat' });
            if (res.ok) return;
            reason = res.reason;
        } catch (e) {
            reason = errorText(e);
        }
        useDraftQueueStore.getState().add(sessionId, text, 'busy');
        Modal.alert(t('errors.sendFailedTitle'), t('joyQueue.sendRetrying', { reason }));
    }, [queue, sessionId]);

    const rows = React.useMemo<QueueRowModel[]>(() => [
        ...held.map((d): QueueRowModel => {
            const failed = d.lastError != null;
            const parked = failed && (d.attempt ?? 0) >= MAX_AUTO_ATTEMPTS;
            // Removal while the send is in flight is deferred until it
            // settles (#134): the row stays, marked, so a POST that lands
            // anyway is never mistaken for a removed message.
            const removing = cancelPending(d.id);
            return {
                id: `app:${d.id}`, text: d.text,
                onChange: (text) => update(sessionId, d.id, text),
                onRemove: () => { if (!removing) cancelRelease(sessionId, d.id); },
                onRetry: failed && !removing ? () => retryRelease(sessionId, d.id) : undefined,
                error: removing
                    ? t('joyQueue.removePending')
                    : failed ? (parked ? t('joyQueue.sendParked', { reason: d.lastError! }) : t('joyQueue.sendRetrying', { reason: d.lastError! })) : null,
            };
        }),
        ...daemonVisible.map((m): QueueRowModel => ({
            id: `daemon:${m.id}`, text: m.text,
            onCommit: (text) => daemonOp(queue.edit(m.id, text)),
            onRemove: () => daemonOp(queue.cancel(m.id)),
            onSteer: (text) => { void steer(m.id, text); },
        })),
        // App-sent, already a bubble: the text is an immutable server row, so
        // an edit cancels the queued delivery and re-stashes the text as a
        // draft — only once the cancel is confirmed, or the edit would be
        // queued twice (#321).
        ...daemonHidden.map((m): QueueRowModel => ({
            id: `daemon-hidden:${m.id}`, text: m.text,
            onCommit: (text) => daemonOp(queue.cancel(m.id).then(() => { useDraftQueueStore.getState().add(sessionId, text); })),
            onRemove: () => daemonOp(queue.cancel(m.id)),
            onSteer: (text) => { void steer(m.id, text); },
        })),
    ], [held, daemonVisible, daemonHidden, sessionId, update, retryRelease, cancelPending, queue, steer, daemonOp]);

    const notice = queue.paused ? {
        text: queue.pauseReason === 'input_dirty'
            ? t('joyQueue.pausedInputDirty')
            : queue.pauseReason === 'dispatch_mismatch'
                ? t('joyQueue.pausedDispatchMismatch')
                : t('joyQueue.pausedDefault'),
        onPress: () => daemonOp(queue.resume()),
    } : null;

    return <QueueStack title={t('joyQueue.pendingTitle')} rows={rows} notice={notice} />;
});
