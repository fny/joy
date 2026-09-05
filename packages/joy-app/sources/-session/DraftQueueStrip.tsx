import * as React from 'react';
import { Modal } from '@/modal';
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
            if (!d.text.trim()) { remove(sessionId, d.id); return; }
            // The draft is removed only once the relay accepted it; a failed
            // send keeps it (with the error on the row) and says so (#10).
            void sync.sendMessage(sessionId, d.text, { source: 'chat', localId: d.id }).then((res) => {
                if (res.ok) { remove(sessionId, d.id); return; }
                useDraftQueueStore.getState().revertRelease(sessionId, d.id, res.reason);
                if (!res.reason.startsWith('attachment upload failed')) Modal.alert(t('errors.sendFailedTitle'), t('errors.sendFailedMessage'), [{ text: t('common.ok'), style: 'cancel' }]);
            });
        },
    })), [drafts, sessionId, update, remove]);
    return <QueueStack title={t('joyQueue.draftsTitle')} rows={rows} />;
});
