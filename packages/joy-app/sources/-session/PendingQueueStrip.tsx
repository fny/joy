import * as React from 'react';
import { useDrafts, draftReason } from './draftQueue';
import { QueueStack } from './QueueStack';

// App-side QUEUE ITEMS — messages auto-held because a turn is processing ahead
// ('busy'). Distinct from deliberate drafts (DraftQueueStrip, below this one)
// and from the daemon's own server queue (JoyQueueStrip, above). draftQueueRelease
// drains these when the turn completes. (Offline sends are NOT here — they ride
// the outbox with a per-message delivery status.) Rendering lives in
// QueueStack, shared with DraftQueueStrip so the two stacks are the same thing.
export const PendingQueueStrip = React.memo(function PendingQueueStrip({ sessionId }: { sessionId: string }) {
    const all = useDrafts(sessionId);
    const items = React.useMemo(() => all.filter((d) => draftReason(d) === 'busy'), [all]);
    return <QueueStack sessionId={sessionId} kind="pending" items={items} />;
});
