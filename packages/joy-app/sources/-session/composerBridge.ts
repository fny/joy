// A message row wants to put text into the composer ("Reuse"), but the
// composer lives three components up (SessionView → ChatComposer → AgentInput)
// and the row is rendered deep inside a virtualized list. Threading a callback
// through ChatList/MessageView/AgentTextBlock for one action is churn on the
// hottest render path — so, like `sync.sendMessage` for option chips, a
// module-level registry keyed by session id. The composer registers itself on
// mount and unregisters on unmount; a row for a session with no live composer
// (nothing mounted) is a no-op.

type ComposerInsert = (text: string) => void;

const composers = new Map<string, ComposerInsert>();

export function registerComposer(sessionId: string, insert: ComposerInsert): () => void {
    composers.set(sessionId, insert);
    return () => {
        if (composers.get(sessionId) === insert) composers.delete(sessionId);
    };
}

/** Put `text` into the session's composer. Returns false when no composer is mounted. */
export function insertIntoComposer(sessionId: string, text: string): boolean {
    const insert = composers.get(sessionId);
    if (!insert) return false;
    insert(text);
    return true;
}
