// ============================================================================
// Reducer Tracer - Message Relationship Tracking for Sidechains
// ============================================================================
//
// This module links sidechain messages (a subagent's own message stream) to
// the Task / Agent CALL that spawned them. Ownership is keyed by the tool
// call id — never by the message id that carried the call: one assistant
// message can hold two parallel Task calls, and keying by message merged both
// subagents' output under the first.
//
// Key Concepts:
// -------------
// 1. Task Tools: a Task / Agent tool call registers its call id, its prompt
//    (Claude sidechain roots are matched by prompt) and its session-protocol
//    subagent id (children reference it as parentUUID).
//
// 2. Sidechains: messages with isSidechain=true. A root (the subagent's
//    prompt) matches a Task by prompt; children reference their parent by
//    parentUUID and inherit its sidechainId (= owning call id).
//
// 3. Out-of-order arrival. Nothing is ever emitted standalone or dropped
//    because its owner has not loaded yet (history pages arrive newest
//    first):
//      - a child whose parent is unknown waits in `orphanMessages`,
//      - a root whose Task is unknown waits in `pendingRoots`,
//      - a subagent-id child whose Task is unknown waits in `orphanMessages`.
//    When the Task / parent arrives, the whole waiting subtree is released.
//
// 4. Release is ITERATIVE end to end: the descent uses an explicit stack and
//    every append is a loop, never a spread into push — 150,000 buffered
//    descendants used to overflow the stack (#389), and because every id had
//    already been marked processed by then, the retry returned nothing. A
//    message is marked processed in the same step that emits it.
//
// ============================================================================

import { NormalizedMessage } from '../typesRaw';

// Extended message type with sidechain ID for tracking message relationships
export type TracedMessage = NormalizedMessage & {
    sidechainId?: string;  // call id of the Task / Agent that owns this sidechain
}

export interface TracerState {
    // Task tracking — by CALL id
    taskTools: Map<string, { callId: string; messageId: string; prompt: string }>;
    // prompt -> unclaimed Task call ids, oldest first (two Tasks may share a prompt)
    promptToTaskIds: Map<string, string[]>;

    // Sidechain tracking - maps message UUIDs to their owning call id
    uuidToSidechainId: Map<string, string>;
    // tool call id / session subagent id -> owning call id
    parentIdToCallId: Map<string, string>;

    // Buffering for out-of-order messages
    orphanMessages: Map<string, NormalizedMessage[]>;  // parentUuid -> children waiting for that parent
    pendingRoots: Map<string, NormalizedMessage[]>;    // prompt -> sidechain roots waiting for their Task

    // Track already processed messages to avoid duplicates
    processedIds: Set<string>;
}

// Create a new tracer state with empty collections
export function createTracer(): TracerState {
    return {
        taskTools: new Map(),
        promptToTaskIds: new Map(),
        uuidToSidechainId: new Map(),
        parentIdToCallId: new Map(),
        orphanMessages: new Map(),
        pendingRoots: new Map(),
        processedIds: new Set()
    };
}

// Extract UUID from the first content item of an agent message
function getMessageUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('uuid' in firstContent && firstContent.uuid) {
            return firstContent.uuid;
        }
    }
    return null;
}

// Extract parent UUID from the first content item of an agent message
function getParentUuid(message: NormalizedMessage): string | null {
    if (message.role === 'agent' && message.content.length > 0) {
        const firstContent = message.content[0];
        if ('parentUUID' in firstContent) {
            return firstContent.parentUUID;
        }
    }
    return null;
}

function getToolCallParentIds(content: { id: string; input: any }): string[] {
    const ids = new Set<string>([content.id]);
    const sessionSubagent = content.input?.sessionSubagent;
    if (typeof sessionSubagent === 'string' && sessionSubagent.length > 0) {
        ids.add(sessionSubagent);
    }
    return [...ids];
}

function isSubagentToolCall(name: string): boolean {
    return name === 'Task' || name === 'Agent';
}

function getSidechainRootPrompt(message: NormalizedMessage): string | null {
    if (message.role !== 'agent') return null;
    for (const content of message.content) {
        if (content.type === 'sidechain' && content.prompt) {
            return content.prompt;
        }
    }
    return null;
}

/**
 * Emit one message with its sidechain and release, transitively, everything
 * waiting on it. Iterative with an explicit stack (depth-first, so emit order
 * matches the recursive version's). Each message is marked processed only in
 * the step that emits it, and the loop cannot throw, so a batch is either
 * returned whole or left retryable.
 */
function emitWithDescendants(state: TracerState, results: TracedMessage[], message: NormalizedMessage, sidechainId: string): void {
    type Frame = { items: NormalizedMessage[]; index: number };
    const stack: Frame[] = [{ items: [message], index: 0 }];

    while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (frame.index >= frame.items.length) {
            stack.pop();
            continue;
        }
        const item = frame.items[frame.index++];
        const uuid = getMessageUuid(item);

        state.processedIds.add(item.id);
        if (uuid) {
            state.uuidToSidechainId.set(uuid, sidechainId);
        }
        results.push({ ...item, sidechainId });

        // Descend into the orphans waiting for this message before its siblings
        if (uuid) {
            const children = state.orphanMessages.get(uuid);
            if (children && children.length > 0) {
                state.orphanMessages.delete(uuid);
                stack.push({ items: children, index: 0 });
            }
        }
    }
}

/** Release the orphans waiting on `parentKey` (a uuid, a call id or a subagent id). */
function releaseOrphans(state: TracerState, results: TracedMessage[], parentKey: string, sidechainId: string): void {
    const orphans = state.orphanMessages.get(parentKey);
    if (!orphans) return;
    state.orphanMessages.delete(parentKey);
    for (let i = 0; i < orphans.length; i++) {
        emitWithDescendants(state, results, orphans[i], sidechainId);
    }
}

function bufferOrphan(state: TracerState, parentKey: string, message: NormalizedMessage): void {
    const orphans = state.orphanMessages.get(parentKey);
    if (orphans) {
        orphans.push(message);
    } else {
        state.orphanMessages.set(parentKey, [message]);
    }
}

/** Claim the oldest unclaimed Task call for `prompt`, if any. */
function claimTaskForPrompt(state: TracerState, prompt: string): string | null {
    const queue = state.promptToTaskIds.get(prompt);
    if (!queue || queue.length === 0) return null;
    const callId = queue.shift()!;
    if (queue.length === 0) state.promptToTaskIds.delete(prompt);
    return callId;
}

// Main tracer function - processes messages and assigns sidechain IDs based on Task relationships
export function traceMessages(state: TracerState, messages: NormalizedMessage[]): TracedMessage[] {
    const results: TracedMessage[] = [];

    for (const message of messages) {
        // Skip if already processed
        if (state.processedIds.has(message.id)) {
            continue;
        }

        // Register tool calls (any depth) so children referencing them — by call
        // id or by session subagent id — can find their owner, and release the
        // children that arrived first.
        if (message.role === 'agent') {
            for (const content of message.content) {
                if (content.type !== 'tool-call') continue;
                for (const parentId of getToolCallParentIds(content)) {
                    state.parentIdToCallId.set(parentId, content.id);
                    releaseOrphans(state, results, parentId, content.id);
                }
                if (isSubagentToolCall(content.name)
                    && content.input && typeof content.input === 'object' && 'prompt' in content.input
                    && typeof content.input.prompt === 'string') {
                    const prompt: string = content.input.prompt;
                    state.taskTools.set(content.id, { callId: content.id, messageId: message.id, prompt });
                    // A root that arrived before its Task claims this call now;
                    // otherwise the call waits for its root.
                    const waitingRoots = state.pendingRoots.get(prompt);
                    if (waitingRoots && waitingRoots.length > 0) {
                        const root = waitingRoots.shift()!;
                        if (waitingRoots.length === 0) state.pendingRoots.delete(prompt);
                        emitWithDescendants(state, results, root, content.id);
                    } else {
                        const queue = state.promptToTaskIds.get(prompt);
                        if (queue) queue.push(content.id); else state.promptToTaskIds.set(prompt, [content.id]);
                    }
                }
            }
        }

        // Non-sidechain messages are returned immediately without sidechain ID
        if (!message.isSidechain) {
            state.processedIds.add(message.id);
            results.push({ ...message });
            continue;
        }

        // Handle sidechain messages - these need to be linked to their originating Task
        const uuid = getMessageUuid(message);
        const parentUuid = getParentUuid(message);
        const rootPrompt = getSidechainRootPrompt(message);

        if (rootPrompt !== null) {
            const callId = claimTaskForPrompt(state, rootPrompt);
            if (callId !== null) {
                emitWithDescendants(state, results, message, callId);
            } else {
                // Task not loaded yet (older page) — wait for it, do not mark processed.
                const roots = state.pendingRoots.get(rootPrompt);
                if (roots) roots.push(message); else state.pendingRoots.set(rootPrompt, [message]);
            }
            continue;
        }

        if (parentUuid) {
            const parentSidechainId = state.uuidToSidechainId.get(parentUuid) ?? state.parentIdToCallId.get(parentUuid);
            if (parentSidechainId) {
                emitWithDescendants(state, results, message, parentSidechainId);
            } else {
                // Parent (a message uuid, a call id or a subagent id) not yet
                // seen — buffer until it arrives instead of emitting a
                // subagent message as a root.
                bufferOrphan(state, parentUuid, message);
            }
            continue;
        }

        // Sidechain message with no parent and not a root - process as standalone
        state.processedIds.add(message.id);
        results.push({ ...message });
    }

    return results;
}
