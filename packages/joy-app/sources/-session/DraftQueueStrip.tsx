import * as React from 'react';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useDrafts, useDraftQueueStore, draftReason } from './draftQueue';
import { QueueStack, type QueueRowModel } from './QueueStack';

// Deliberate drafts only — messages the user explicitly stashed (Save draft).
// Never auto-sent: edited inline, removed, or sent by hand (↑). Same stack as
// Waiting (WaitingStack), which sits above it.
export const DraftQueueStrip = React.memo(function DraftQueueStrip({ sessionId }: { sessionId: string }) {
    const all = useDrafts(sessionId);
    const drafts = React.useMemo(() => all.filter((d) => draftReason(d) === 'draft'), [all]);
    const update = useDraftQueueStore((s) => s.update);
    const remove = useDraftQueueStore((s) => s.remove);
    const rows = React.useMemo<QueueRowModel[]>(() => drafts.map((d) => ({
        id: d.id, text: d.text,
        onChange: (text) => update(sessionId, d.id, text),
        onRemove: () => remove(sessionId, d.id),
        onSend: () => {
            if (d.text.trim()) void sync.sendMessage(sessionId, d.text, { source: 'chat' });
            remove(sessionId, d.id);
        },
    })), [drafts, sessionId, update, remove]);
    return <QueueStack title={t('joyQueue.draftsTitle')} rows={rows} />;
});
