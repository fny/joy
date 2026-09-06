import * as React from 'react';
import { beginSend, sendSucceeded, sendFailed } from '@/utils/sendKey';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useDrafts, useDraftQueueStore, draftReason } from './draftQueue';
import { QueueStack, type QueueRowModel } from './QueueStack';

// One send per draft at a time: beginSend mints a new key for a pending
// duplicate, so a second tap before the ack sent the draft twice (#10). The
// guard is module-level, keyed by session+draft — a component ref reset on
// remount while the send was still pending (Astra on bfcec9fd).
const sendingDrafts = new Set<string>();

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
        error: d.lastError ?? null,
        onChange: (text) => update(sessionId, d.id, text),
        onRemove: () => remove(sessionId, d.id),
        onSend: () => {
            if (!d.text.trim()) { remove(sessionId, d.id); return; }
            const sendKey = `${sessionId}:${d.id}`;
            if (sendingDrafts.has(sendKey)) return;
            sendingDrafts.add(sendKey);
            // The draft is removed only once the relay accepted it; a failed
            // send keeps it (with the error on the row) and says so (#10).
            const sentText = d.text;
            // Fresh key per send; reused only for an exact retry of a FAILED send,
            // so an edited draft is a new message and an unchanged retry replays
            // the relay's acceptance (#10).
            const scope = `draft:${sessionId}:${d.id}`;
            const localId = beginSend(scope, sentText);
            void sync.sendMessage(sessionId, sentText, { source: 'chat', localId }).then((res) => {
                if (res.ok) {
                    sendSucceeded(scope, localId);
                    // Remove only what was sent: an edit made while the send was
                    // in flight is a new draft, not the delivered one.
                    const now = useDraftQueueStore.getState().bySession[sessionId]?.find((x) => x.id === d.id);
                    if (!now || now.text === sentText) remove(sessionId, d.id);
                    return;
                }
                sendFailed(scope, localId);
                useDraftQueueStore.getState().revertRelease(sessionId, d.id, res.reason);
                if (!res.reason.startsWith('attachment upload failed')) Modal.alert(t('errors.sendFailedTitle'), t('errors.sendFailedMessage'), [{ text: t('common.ok'), style: 'cancel' }]);
            }).finally(() => { sendingDrafts.delete(sendKey); });
        },
    })), [drafts, sessionId, update, remove]);
    return <QueueStack title={t('joyQueue.draftsTitle')} rows={rows} />;
});
