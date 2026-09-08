import * as React from 'react';
import { beginSend, sendSucceeded, sendFailed } from '@/utils/sendKey';
import { Modal } from '@/modal';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { useDrafts, useDraftQueueStore, draftReason } from './draftQueue';
import { findMissingAttachments, fileExists, liveAttachments } from './draftAttachments';
import { QueueStack, type QueueRowModel } from './QueueStack';

// One send per draft at a time: beginSend mints a new key for a pending
// duplicate, so a second tap before the ack sent the draft twice (#10). The
// guard is module-level, keyed by session+draft — a component ref reset on
// remount while the send was still pending (Astra on 90874d21).
const sendingDrafts = new Set<string>();

// Deliberate drafts only — messages the user explicitly stashed (Save draft).
// Never auto-sent: edited inline, removed, or sent by hand (↑). Same stack as
// Waiting (WaitingStack), which sits above it.
export const DraftQueueStrip = React.memo(function DraftQueueStrip({ sessionId }: { sessionId: string }) {
    const all = useDrafts(sessionId);
    const drafts = React.useMemo(() => all.filter((d) => draftReason(d) === 'draft'), [all]);
    const update = useDraftQueueStore((s) => s.update);
    const remove = useDraftQueueStore((s) => s.remove);
    const noteMissing = useDraftQueueStore((s) => s.noteMissingAttachments);

    // Verify stashed images still exist (#650). The OS purges its cache
    // directory under storage pressure while the app is not running, so this
    // checks on mount and whenever the drafts change — the two moments a
    // vanished file could first become visible. noteMissingAttachments is a
    // no-op when the answer has not changed, so this cannot loop.
    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            for (const d of drafts) {
                if (!d.attachments?.length) continue;
                const missing = await findMissingAttachments(d.attachments, fileExists);
                if (!cancelled) noteMissing(sessionId, d.id, missing);
            }
        })();
        return () => { cancelled = true; };
    }, [drafts, sessionId, noteMissing]);

    const rows = React.useMemo<QueueRowModel[]>(() => drafts.map((d) => ({
        id: d.id, text: d.text,
        // A dead attachment outranks a stale send error: it is the thing that
        // will surprise you, and it is why this row is not going anywhere.
        error: (d.missingAttachments?.length
            ? t('drafts.attachmentsMissing', { count: d.missingAttachments.length, total: d.attachments?.length ?? 0 })
            : d.lastError) ?? null,
        onChange: (text) => update(sessionId, d.id, text),
        onRemove: () => remove(sessionId, d.id),
        onSend: () => {
            // Sending a draft whose images are gone would quietly deliver
            // fewer than it shows. Make it a decision, not a surprise (#650).
            if (d.missingAttachments?.length) {
                const live = liveAttachments(d.attachments, d.missingAttachments);
                Modal.alert(
                    t('drafts.attachmentsMissingTitle'),
                    t('drafts.attachmentsMissingBody', { count: d.missingAttachments.length }),
                    [
                        { text: t('common.cancel'), style: 'cancel' },
                        {
                            text: t('drafts.sendWithout'),
                            onPress: () => {
                                // Drop the dead refs so the row stops warning and the
                                // normal path can take it from here.
                                useDraftQueueStore.getState().noteMissingAttachments(sessionId, d.id, []);
                                update(sessionId, d.id, d.text);
                                void sync.sendMessage(sessionId, d.text, {
                                    source: 'chat',
                                    localId: beginSend(`draft:${sessionId}:${d.id}`, d.text),
                                    ...(live.length > 0 ? { attachments: live as never } : {}),
                                }).then((res) => { if (res.ok) remove(sessionId, d.id); });
                            },
                        },
                    ],
                );
                return;
            }
            if (!d.text.trim() && !d.attachments?.length) { remove(sessionId, d.id); return; }
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
            void sync.sendMessage(sessionId, sentText, {
                source: 'chat',
                localId,
                ...(d.attachments?.length ? { attachments: d.attachments as never } : {}),
            }).then((res) => {
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
                if (!res.reason.startsWith('attachment upload failed')) Modal.alert(t('errors.sendFailedTitle'), (res.reason === t('errors.sessionFull') ? res.reason : t('errors.sendFailedMessage')), [{ text: t('common.ok'), style: 'cancel' }]);
            }).finally(() => { sendingDrafts.delete(sendKey); });
        },
    })), [drafts, sessionId, update, remove]);
    return <QueueStack title={t('joyQueue.draftsTitle')} rows={rows} />;
});
