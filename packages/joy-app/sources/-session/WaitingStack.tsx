import * as React from 'react';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useDrafts, useDraftQueueStore, draftReason } from './draftQueue';
import { MAX_AUTO_ATTEMPTS } from './draftQueueRelease';
import { QueueStack, type QueueRowModel } from './QueueStack';
import type { useJoyQueue } from '@/hooks/useJoyQueue';
import { useDelayedAppearance } from '@/hooks/useDelayedAppearance';

type Queue = ReturnType<typeof useJoyQueue>;

// Every app send transits the daemon's dispatch queue for ~a second even when
// the agent is idle; items younger than this are in transit, not held, and
// rendering them flashed "waiting" on every send. Anything older genuinely is.
const APPEAR_MS = 2500;

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
    const remove = useDraftQueueStore((s) => s.remove);
    const retryRelease = useDraftQueueStore((s) => s.retryRelease);

    const daemonVisible = useDelayedAppearance(queue.queue, APPEAR_MS, queue.paused);
    const daemonHidden = useDelayedAppearance(queue.hidden ?? [], APPEAR_MS, queue.paused);

    const steer = React.useCallback((id: string, text: string) => {
        void queue.cancel(id);
        void sync.sendMessage(sessionId, `/steer ${text}`, { source: 'chat' });
    }, [queue, sessionId]);

    const rows = React.useMemo<QueueRowModel[]>(() => [
        ...held.map((d): QueueRowModel => {
            const failed = d.lastError != null;
            const parked = failed && (d.attempt ?? 0) >= MAX_AUTO_ATTEMPTS;
            return {
                id: `app:${d.id}`, text: d.text,
                onChange: (text) => update(sessionId, d.id, text),
                onRemove: () => remove(sessionId, d.id),
                onRetry: failed ? () => retryRelease(sessionId, d.id) : undefined,
                error: failed ? (parked ? t('joyQueue.sendParked', { reason: d.lastError! }) : t('joyQueue.sendRetrying', { reason: d.lastError! })) : null,
            };
        }),
        ...daemonVisible.map((m): QueueRowModel => ({
            id: `daemon:${m.id}`, text: m.text,
            onCommit: (text) => { void queue.edit(m.id, text); },
            onRemove: () => { void queue.cancel(m.id); },
            onSteer: () => steer(m.id, m.text),
        })),
        // App-sent, already a bubble: the text is an immutable server row, so
        // an edit cancels the queued delivery and re-stashes the text as a draft.
        ...daemonHidden.map((m): QueueRowModel => ({
            id: `daemon-hidden:${m.id}`, text: m.text,
            onCommit: (text) => { void queue.cancel(m.id); useDraftQueueStore.getState().add(sessionId, text); },
            onRemove: () => { void queue.cancel(m.id); },
            onSteer: () => steer(m.id, m.text),
        })),
    ], [held, daemonVisible, daemonHidden, sessionId, update, remove, retryRelease, queue, steer]);

    const notice = queue.paused ? {
        text: queue.pauseReason === 'input_dirty'
            ? t('joyQueue.pausedInputDirty')
            : queue.pauseReason === 'dispatch_mismatch'
                ? t('joyQueue.pausedDispatchMismatch')
                : t('joyQueue.pausedDefault'),
        onPress: () => { void queue.resume(); },
    } : null;

    return <QueueStack title={t('joyQueue.pendingTitle')} rows={rows} notice={notice} />;
});
