import * as React from 'react';
import { useDrafts, draftReason } from './draftQueue';
import { QueueStack } from './QueueStack';

// Deliberate drafts only — messages the user explicitly stashed (Save draft).
// These never auto-send: each is edited inline, deleted, or sent by hand.
// Rendering lives in QueueStack, shared with PendingQueueStrip so the two
// stacks look and behave identically.
export const DraftQueueStrip = React.memo(function DraftQueueStrip({ sessionId }: { sessionId: string }) {
    const all = useDrafts(sessionId);
    const drafts = React.useMemo(() => all.filter((d) => draftReason(d) === 'draft'), [all]);
    return <QueueStack sessionId={sessionId} kind="draft" items={drafts} />;
});
