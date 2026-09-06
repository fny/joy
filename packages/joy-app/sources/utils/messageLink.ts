import type { Href } from 'expo-router';
import type { ReducerState } from '@/sync/reducer/reducer';
import type { Message, ToolCallMessage } from '@/sync/typesMessage';

/**
 * Durable message links (#165).
 *
 * A tool card, a group row and a notification all link to
 * `/session/:id/message/:messageId`. The id they used to put there was the
 * REDUCER's row id — a random string allocated when the row was projected —
 * so the same server row got a different id in every fresh reducer, and a
 * link opened after a restart (or after the session's store was evicted and
 * rebuilt) could page the whole history without ever finding its target.
 *
 * Links now carry durable identity: the harness CALL id for a tool call (the
 * canonical model's identity key, stable across reducers and across the root
 * placeholder / nested copy of one call). The resolver accepts exactly those,
 * plus a server message id, and still honours a reducer-local id for links
 * minted within the same store.
 */

/** The minimum of a session's message store the resolver reads. */
export type MessageLinkStore = {
    messagesMap: Record<string, Message>;
    reducerState?: ReducerState | null;
};

/** The durable id a link to `message` carries. */
export function messageLinkId(message: Message): string {
    if (message.kind === 'tool-call') {
        const callId = message.tool.model?.identity.callId;
        if (typeof callId === 'string' && callId.length > 0) {
            return callId;
        }
    }
    return message.id;
}

/** The detail route for `message`, addressed by durable identity. */
export function messageDetailPath(sessionId: string, message: Message): Href {
    return `/session/${sessionId}/message/${encodeURIComponent(messageLinkId(message))}` as Href;
}

const MAX_OWNER_HOPS = 64;

function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** The root row (no owner) that carries the nested row `mid`, walking the owner chain. */
function rootMidOf(reducerState: ReducerState, mid: string): string | null {
    let current = reducerState.messages.get(mid);
    let currentMid = mid;
    let hops = 0;
    while (current?.ownerCallId && hops < MAX_OWNER_HOPS) {
        const owner = current.ownerCallId;
        const rootMid = reducerState.toolIdToMessageId.get(owner);
        const rootRow = rootMid ? reducerState.messages.get(rootMid) : undefined;
        if (rootMid && rootRow && !rootRow.ownerCallId) {
            return rootMid;
        }
        const nestedMid = reducerState.sidechainToolIdToMessageId.get(owner);
        if (!nestedMid) return null;
        currentMid = nestedMid;
        current = reducerState.messages.get(nestedMid);
        hops++;
    }
    return current && !current.ownerCallId ? currentMid : null;
}

/** Depth-first search of a projected tree for the tool call `callId`. */
function findNestedCall(message: Message, callId: string): ToolCallMessage | null {
    if (message.kind !== 'tool-call') return null;
    type Frame = { items: Message[]; index: number };
    const stack: Frame[] = [{ items: message.children, index: 0 }];
    let visited = 0;
    while (stack.length > 0 && visited < 100_000) {
        const frame = stack[stack.length - 1];
        if (frame.index >= frame.items.length) {
            stack.pop();
            continue;
        }
        const item = frame.items[frame.index++];
        visited++;
        if (item.kind !== 'tool-call') continue;
        if (item.tool.model?.identity.callId === callId) return item;
        if (item.children.length > 0) stack.push({ items: item.children, index: 0 });
    }
    return null;
}

/**
 * The projected message a link addresses, or null when it is not in the
 * store (yet — the caller pages history). Accepts, in order: a row id of
 * this store, a tool call id (root row, or a row nested inside a Task at
 * any depth), and a server message id of a root row.
 */
export function resolveMessageLink(store: MessageLinkStore | null | undefined, linkId: string | null | undefined): Message | null {
    if (!store || !linkId) return null;
    const decoded = safeDecode(linkId);
    const candidates = decoded === linkId ? [linkId] : [linkId, decoded];

    for (const id of candidates) {
        const direct = store.messagesMap[id];
        if (direct) return direct;
    }

    const reducerState = store.reducerState;
    if (!reducerState) return null;

    for (const id of candidates) {
        // A nested copy of the call, inside its owner's projection.
        const nestedMid = reducerState.sidechainToolIdToMessageId.get(id);
        if (nestedMid) {
            const rootMid = rootMidOf(reducerState, nestedMid);
            const root = rootMid ? store.messagesMap[rootMid] : undefined;
            const nested = root ? findNestedCall(root, id) : null;
            if (nested) return nested;
        }
        // The root row holding the call (an ordinary root call, or a root
        // permission placeholder for a nested one).
        const rootMid = reducerState.toolIdToMessageId.get(id);
        if (rootMid) {
            const root = store.messagesMap[rootMid];
            if (root) return root;
        }
    }

    // A server message id of a root row.
    for (const id of candidates) {
        for (const [mid, row] of reducerState.messages) {
            if (row.realID === id && !row.ownerCallId) {
                const root = store.messagesMap[mid];
                if (root) return root;
            }
        }
    }
    return null;
}
