/**
 * Message Reducer for Real-time Sync System
 *
 * This reducer is the core message processing engine that transforms raw messages from
 * the sync system into a structured, deduplicated message history. It handles complex
 * scenarios including tool permissions, sidechains, and message deduplication.
 *
 * ## Core Responsibilities:
 *
 * 1. **Message Deduplication**: Prevents duplicate messages using multiple tracking mechanisms:
 *    - localId tracking for user messages
 *    - messageId tracking for all messages
 *    - Permission ID tracking for tool permissions
 *
 * 2. **Tool Permission Management**: Integrates with AgentState to handle tool permissions:
 *    - Creates placeholder messages for pending permission requests
 *    - Updates permission status (pending → approved/denied/canceled) on EVERY copy
 *      of the call (the root placeholder and a subagent's nested copy)
 *    - Matches incoming tool calls to approved permissions
 *
 * 3. **Tool Call Lifecycle** — an IDENTITY-BASED projection:
 *    - Every tool call is indexed by its harness call id, at the root and inside
 *      sidechains. A result whose call has not arrived yet (older history page)
 *      is RETAINED in `pendingResults` and applied when the call lands — never
 *      discarded. EVERY observed result is kept by call identity in
 *      `toolResults`, so a copy of the call projected later (a subagent's
 *      nested row after a root permission placeholder) settles too.
 *    - Duplicate observations (live event + replayed history) merge idempotently:
 *      a second result for a settled call is a no-op, a second call for a known
 *      id updates the same row.
 *    - A permission placeholder acquires the real call's server `seq` when the
 *      call arrives, so it settles into log order instead of floating as newest.
 *    - The canonical tool model (sync/toolModel.ts) is attached at projection
 *      time with the call's identity (session / turn / message / call / parent).
 *
 * 4. **Sidechain Processing**: Handles nested conversation branches (sidechains):
 *    - Children are keyed by the OWNING CALL id (parallel Task calls in one
 *      message keep their own output)
 *    - Nested sidechains propagate changes to the outermost root; only roots are
 *      ever emitted in the result delta
 *
 * 5. **Historical lifecycle events** update historical state only: a snapshot
 *    (usage, todos, plan-mode transitions) is taken from a message only when it
 *    is newer (server seq, then timestamp) than what the state already holds, so
 *    paging history backward never overwrites the current snapshot.
 *
 * ## Processing Phases:
 *
 * **Phase 0: AgentState Permissions**
 * **Phase 0.5: Message-to-Event Conversion** (per content block — sibling
 *   blocks of an event keep flowing through normal processing)
 * **Phase 1: User & text messages**
 * **Phase 2: Tool calls** (root)
 * **Phase 3: Tool results** (root; unmatched retained)
 * **Phase 4: Sidechains**
 * **Phase 5: Mode Switch Events**
 *
 * ## Key Behaviors:
 *
 * - **Idempotency**: Calling the reducer multiple times with the same data produces no duplicates
 * - **Priority Rules**: When both tool calls and permissions exist, tool calls take priority
 * - **Timestamp Preservation**: NEVER change a message's createdAt timestamp.
 * - **Indexed entities**: every lookup is a Map lookup; no phase scans the whole
 *   message log, so a batch costs what the batch contains, not what the log holds.
 */

import { Message, ToolCall, DeliveryStage } from "../typesMessage";
import { AgentEvent, MessageAttachment, NormalizedMessage, UsageData } from "../typesRaw";
import { createTracer, traceMessages, TracerState } from "./reducerTracer";
import { AgentState, TodoItem, TodoItemsSchema } from "../storageTypes";
import { MessageMeta } from "../typesMessageMeta";
import { splitMessageEvents } from "./messageToEvent";
import { buildToolModel } from "../toolModel";

type ReducerMessage = {
    id: string;
    realID: string | null;
    seq: number | null;
    createdAt: number;
    role: 'user' | 'agent';
    text: string | null;
    isThinking?: boolean;
    event: AgentEvent | null;
    tool: ToolCall | null;
    meta?: MessageMeta;
    claudeUuid?: string;
    isCompactSummary?: boolean;
    attachments?: MessageAttachment[];
    /** Optimistic-send progress; only set on rows this client inserted. */
    deliveryStage?: DeliveryStage;
    /** Relay turn the prompt opened — how lifecycle events find this row. */
    turnId?: string;
    /** Harness call id of a tool row (permission id for a placeholder). */
    callId?: string;
    /** Owning Task / Agent call id for a row inside a sidechain. */
    ownerCallId?: string;
}

type StoredPermission = {
    tool: string;
    arguments: any;
    createdAt: number;
    completedAt?: number;
    status: 'pending' | 'approved' | 'denied' | 'canceled';
    reason?: string;
    mode?: string;
    allowedTools?: string[];
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
};

type ToolResultObservation = {
    content: unknown;
    isError: boolean;
    createdAt: number;
    seq: number | null;
    permissions?: {
        date: number;
        result: 'approved' | 'denied';
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    };
};

export type PlanModeTransition = 'enter' | 'exit';

export type ReducerState = {
    /** Session the projection belongs to (identity on every tool model). */
    sessionId: string | null;
    toolIdToMessageId: Map<string, string>; // root call id / permission id -> messageId
    sidechainToolIdToMessageId: Map<string, string>; // sidechain call id -> sidechain messageId
    /** Results observed before their call — applied when the call arrives. */
    pendingResults: Map<string, ToolResultObservation>;
    /** Every result observed, by call id — applied to every later copy of the call. */
    toolResults: Map<string, ToolResultObservation>;
    permissions: Map<string, StoredPermission>; // Store permission details by ID for quick lookup
    localIds: Map<string, string>;
    messageIds: Map<string, string>; // originalId -> internalId
    turnIds: Map<string, string>; // relay turnId -> internalId (user prompts only)
    messages: Map<string, ReducerMessage>;
    sidechains: Map<string, ReducerMessage[]>; // owning call id -> children
    tracerState: TracerState; // Tracer state for sidechain processing
    /** Highest server seq projected so far — the line between history and live. */
    maxSeq: number | null;
    latestTodos?: {
        todos: TodoItem[];
        timestamp: number;
        seq?: number | null;
    };
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
        seq?: number | null;
    };
};

export function createReducer(sessionId?: string | null): ReducerState {
    return {
        sessionId: sessionId ?? null,
        toolIdToMessageId: new Map(),
        sidechainToolIdToMessageId: new Map(),
        pendingResults: new Map(),
        toolResults: new Map(),
        permissions: new Map(),
        messages: new Map(),
        localIds: new Map(),
        messageIds: new Map(),
        turnIds: new Map(),
        sidechains: new Map(),
        tracerState: createTracer(),
        maxSeq: null,
    }
};

const ENABLE_LOGGING = false;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeToolInputs(existingInput: unknown, nextInput: unknown): unknown {
    if (isRecord(existingInput) && isRecord(nextInput)) {
        return { ...nextInput, ...existingInput };
    }
    return nextInput ?? existingInput;
}

/** The row holding call `callId` — the root row first, then a sidechain copy. */
function findToolRow(state: ReducerState, callId: string): { mid: string; message: ReducerMessage } | null {
    const rootMid = state.toolIdToMessageId.get(callId);
    if (rootMid) {
        const message = state.messages.get(rootMid);
        if (message?.tool) return { mid: rootMid, message };
    }
    const sidechainMid = state.sidechainToolIdToMessageId.get(callId);
    if (sidechainMid) {
        const message = state.messages.get(sidechainMid);
        if (message?.tool) return { mid: sidechainMid, message };
    }
    return null;
}

/** Every row holding call `callId` (root placeholder and nested copy). */
function findToolRows(state: ReducerState, callId: string): Array<{ mid: string; message: ReducerMessage }> {
    const rows: Array<{ mid: string; message: ReducerMessage }> = [];
    const rootMid = state.toolIdToMessageId.get(callId);
    if (rootMid) {
        const message = state.messages.get(rootMid);
        if (message?.tool) rows.push({ mid: rootMid, message });
    }
    const sidechainMid = state.sidechainToolIdToMessageId.get(callId);
    if (sidechainMid && sidechainMid !== rootMid) {
        const message = state.messages.get(sidechainMid);
        if (message?.tool) rows.push({ mid: sidechainMid, message });
    }
    return rows;
}

/**
 * Mark every displayed projection of `mid` as changed. A row inside a
 * sidechain is rendered through its owning Task; emitting the row itself put
 * a subagent child in the root list and left the Task stale. The walk follows
 * the copy that STRUCTURALLY owns the row — the owner's nested copy — up to
 * the outermost root; a root permission placeholder for the same call is a
 * visible projection too and is refreshed, but preferring it ended the walk
 * there and left the real ancestor stale (#394).
 */
function markChanged(state: ReducerState, changed: Set<string>, mid: string): void {
    let currentMid = mid;
    let message = state.messages.get(currentMid);
    let hops = 0;
    while (message?.ownerCallId && hops < 64) {
        const rows = findToolRows(state, message.ownerCallId);
        if (rows.length === 0) break;
        let next: { mid: string; message: ReducerMessage } | null = null;
        for (const row of rows) {
            if (row.message.ownerCallId) next = row; else changed.add(row.mid);
        }
        if (!next) next = rows[0];
        currentMid = next.mid;
        message = next.message;
        hops++;
    }
    changed.add(currentMid);
}

/** Refresh every projection of the call `callId` (root placeholder and nested copy), through every nesting level. */
function markCallChanged(state: ReducerState, changed: Set<string>, callId: string): void {
    for (const row of findToolRows(state, callId)) {
        markChanged(state, changed, row.mid);
    }
}

function getVisibleSidechainPrompt(owner: ReducerMessage | null): string | null {
    const prompt = owner?.tool?.input?.prompt;
    if (typeof prompt !== 'string') {
        return null;
    }
    const normalized = prompt.trim();
    return normalized.length > 0 ? normalized : null;
}

function isDuplicateSidechainPrompt(
    existingSidechain: ReducerMessage[],
    ownerPrompt: string | null,
    text: string,
): boolean {
    if (existingSidechain.length > 0 || !ownerPrompt) {
        return false;
    }

    return text.trim() === ownerPrompt;
}

export type ReducerResult = {
    messages: Message[];
    todos?: TodoItem[];
    usage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
    };
    hasReadyEvent?: boolean;
    /**
     * Plan-mode transition carried by FRESH messages in this batch (newer than
     * anything projected before). Older pages and replays never report one, so
     * loading history cannot flip the current permission mode.
     */
    planModeTransition?: PlanModeTransition;
};

/**
 * latestUsage/latestTodos track the most RECENT turn's snapshot. Prefer the
 * server seq (monotonic, gap-free) over createdAt when deciding "is this
 * newer?": an agent envelope's createdAt is transcript-production time and can
 * be backfilled/skewed (and a Date.parse miss falls back to a wall-clock now),
 * so a createdAt-only check can wrongly reject the actually-latest snapshot
 * when a turn is relayed late. Falls back to timestamp when either side has no
 * seq (e.g. context-reset markers, locally generated messages).
 */
function isLaterSnapshot(latest: { seq?: number | null; timestamp: number } | undefined, seq: number | null, timestamp: number): boolean {
    if (!latest) return true;
    if (seq != null && latest.seq != null) return seq > latest.seq;
    return timestamp > latest.timestamp;
}

function updateLatestTodos(state: ReducerState, value: unknown, timestamp: number, seq: number | null) {
    const parsed = TodoItemsSchema.safeParse(value);
    if (!parsed.success) {
        return;
    }

    if (isLaterSnapshot(state.latestTodos, seq, timestamp)) {
        state.latestTodos = {
            todos: parsed.data,
            timestamp,
            seq,
        };
    }
}

/**
 * The server echo of an optimistic local send (matched by localId) carries the
 * authoritative `seq` that the locally-rendered copy never had. Upgrade the
 * existing reducer message's seq in place and re-emit it so it settles into
 * server-log order. Without this, a client's own sends keep seq=null forever
 * and the seq-based display sort can't place them correctly once messages
 * start arriving out of createdAt order.
 */
function reconcileSeq(state: ReducerState, changed: Set<string>, msg: NormalizedMessage): void {
    const internalId = (msg.localId ? state.localIds.get(msg.localId) : undefined)
        ?? state.messageIds.get(msg.id);
    if (!internalId) return;
    const existing = state.messages.get(internalId);
    if (!existing) return;
    if (msg.seq != null && existing.seq !== msg.seq) {
        existing.seq = msg.seq;
        existing.realID = msg.id;
        state.messageIds.set(msg.id, internalId);
        changed.add(internalId);
    }
    // The relay's own row for an optimistic send: learn the turn it opened
    // (lifecycle events key on it), take the attachment citations the
    // optimistic row could not have had (ids exist only after upload), and
    // the echo itself is proof the relay accepted it.
    const turnId = msg.meta?.turnId;
    if (turnId && existing.turnId !== turnId) {
        existing.turnId = turnId;
        state.turnIds.set(turnId, internalId);
        changed.add(internalId);
    }
    const incomingAttachments = (msg.content as { attachments?: MessageAttachment[] } | undefined)?.attachments;
    if (incomingAttachments?.length && !existing.attachments?.length) {
        existing.attachments = incomingAttachments;
        changed.add(internalId);
    }
    if (existing.deliveryStage && STAGE_ORDER[existing.deliveryStage] < STAGE_ORDER.relay) {
        existing.deliveryStage = 'relay';
        changed.add(internalId);
    }
}

/**
 * Reconcile the authoritative `seq` of the client's OWN sends from the POST
 * /messages ack — the only place a sender learns its messages' seq, since the
 * live socket broadcast never echoes the sender's own rows back. Without this,
 * an optimistic user send keeps seq=null until a full reload and the seq-based
 * display sort floats it to "now" (newest), detaching it from the agent turn it
 * triggered. Safe by construction: reconcileSeq no-ops on any localId/id the
 * reducer hasn't seen, so a stray ack can never materialise a phantom message.
 * Returns the reducer's Message objects whose seq changed, for the caller to
 * re-merge and re-sort.
 */
export function reconcileSentSeqs(
    state: ReducerState,
    acks: Array<{ id: string; seq: number; localId: string | null }>
): Message[] {
    const changed = new Set<string>();
    for (const ack of acks) {
        reconcileSeq(state, changed, {
            role: 'user',
            id: ack.id,
            localId: ack.localId,
            seq: ack.seq,
        } as unknown as NormalizedMessage);
    }
    const result: Message[] = [];
    for (const internalId of changed) {
        const m = state.messages.get(internalId);
        if (!m) continue;
        const converted = convertReducerMessageToMessage(m, state);
        if (converted) result.push(converted);
    }
    return result;
}

const STAGE_ORDER: Record<DeliveryStage, number> = { local: 0, relay: 1, daemon: 2, agent: 3 };

/** Learn which relay turn an optimistic send opened (the POST ack carries it
 *  before any event does). Returns the changed message, if any. */
export function bindTurnToLocal(state: ReducerState, localId: string, turnId: string): Message[] {
    const internalId = state.localIds.get(localId);
    const m = internalId ? state.messages.get(internalId) : undefined;
    if (!internalId || !m) return [];
    state.turnIds.set(turnId, internalId);
    if (m.turnId === turnId) return [];
    m.turnId = turnId;
    const converted = convertReducerMessageToMessage(m, state);
    return converted ? [converted] : [];
}

/** Advance an optimistic send's delivery stage — by localId (our own ack) or
 *  by turnId (relay lifecycle events). Monotonic: a late, lower stage never
 *  regresses the row. Rows with NO stage (history, other devices) are left
 *  alone — they are already rendered as delivered. */
export function advanceDeliveryStage(
    state: ReducerState,
    ref: { localId?: string; turnId?: string },
    stage: DeliveryStage,
): Message[] {
    const internalId = (ref.localId ? state.localIds.get(ref.localId) : undefined)
        ?? (ref.turnId ? state.turnIds.get(ref.turnId) : undefined);
    const m = internalId ? state.messages.get(internalId) : undefined;
    if (!internalId || !m || !m.deliveryStage) return [];
    if (STAGE_ORDER[m.deliveryStage] >= STAGE_ORDER[stage]) return [];
    m.deliveryStage = stage;
    const converted = convertReducerMessageToMessage(m, state);
    return converted ? [converted] : [];
}

/** Drop an optimistic row whose send failed — maps included, so a retry with
 *  the same localId creates a fresh row instead of reconciling into a ghost. */
export function forgetLocalMessage(state: ReducerState, localId: string): string | null {
    const internalId = state.localIds.get(localId);
    if (!internalId) return null;
    const m = state.messages.get(internalId);
    state.localIds.delete(localId);
    // The tracer dedupes by id BEFORE the reducer sees a message — leave it
    // remembered and the retry is silently swallowed upstream of everything.
    state.tracerState.processedIds.delete(localId);
    if (m) {
        if (m.realID) {
            state.messageIds.delete(m.realID);
            state.tracerState.processedIds.delete(m.realID);
        }
        if (m.turnId) state.turnIds.delete(m.turnId);
    }
    state.messages.delete(internalId);
    return internalId;
}

/**
 * Apply a result observation to a tool row. Idempotent: a call that has
 * already settled (a duplicate live/history observation, or a placeholder
 * settled by a denial) is left as it is.
 */
function applyToolResult(state: ReducerState, message: ReducerMessage, result: ToolResultObservation): boolean {
    if (!message.tool || message.tool.state !== 'running') {
        return false;
    }
    message.tool.state = result.isError ? 'error' : 'completed';
    message.tool.result = result.content;
    message.tool.completedAt = result.createdAt;

    // Update permission data if provided by backend
    if (result.permissions) {
        const existingDecision = message.tool.permission?.decision;
        message.tool.permission = {
            ...(message.tool.permission ?? {}),
            id: message.callId ?? message.tool.permission?.id ?? '',
            status: result.permissions.result === 'approved' ? 'approved' : 'denied',
            date: result.permissions.date,
            mode: result.permissions.mode,
            allowedTools: result.permissions.allowedTools,
            decision: result.permissions.decision || existingDecision
        };
    }

    if (message.tool.name === 'TodoWrite' && !result.isError) {
        const newTodos = isRecord(result.content) ? result.content.newTodos : undefined;
        updateLatestTodos(state, newTodos, result.createdAt, result.seq);
    }
    return true;
}

/**
 * Remember a result by call identity. Kept even once applied: a root
 * permission placeholder counted as "the call" and consumed the result, and
 * the subagent's nested row that arrived afterwards stayed running with no
 * result at all (#392).
 */
function rememberToolResult(state: ReducerState, callId: string, observation: ToolResultObservation): void {
    if (!state.toolResults.has(callId)) {
        state.toolResults.set(callId, observation);
    }
}

/**
 * Apply the result already observed for `callId` — retained before any copy
 * of the call existed, or applied to another copy — to a row that has not
 * settled yet.
 */
function applyPendingResult(state: ReducerState, callId: string, message: ReducerMessage): boolean {
    const known = state.toolResults.get(callId);
    if (!known) return false;
    const applied = applyToolResult(state, message, known);
    if (applied) state.pendingResults.delete(callId);
    return applied;
}

/**
 * Apply a completed permission (from agentState) to one row holding the call.
 * Returns whether the row changed.
 */
function applyCompletedPermission(
    message: ReducerMessage,
    permId: string,
    completed: NonNullable<AgentState['completedRequests']>[string],
): boolean {
    if (!message.tool) return false;
    // Skip if tool has already started actual execution with approval
    if (message.tool.startedAt && message.tool.permission?.status === 'approved') {
        return false;
    }
    // Skip if permission already has date (came from tool result - preferred over agentState)
    if (message.tool.permission?.date) {
        return false;
    }
    const needsUpdate =
        message.tool.permission?.status !== completed.status ||
        message.tool.permission?.reason !== completed.reason ||
        message.tool.permission?.mode !== completed.mode ||
        message.tool.permission?.allowedTools !== completed.allowedTools ||
        message.tool.permission?.decision !== completed.decision;
    if (!needsUpdate) {
        return false;
    }

    if (!message.tool.permission) {
        message.tool.permission = {
            id: permId,
            status: completed.status,
            mode: completed.mode || undefined,
            allowedTools: completed.allowedTools || undefined,
            decision: completed.decision || undefined,
            reason: completed.reason || undefined
        };
    } else {
        message.tool.permission.status = completed.status;
        message.tool.permission.mode = completed.mode || undefined;
        message.tool.permission.allowedTools = completed.allowedTools || undefined;
        message.tool.permission.decision = completed.decision || undefined;
        if (completed.reason) {
            message.tool.permission.reason = completed.reason;
        }
    }

    if (completed.status === 'approved') {
        if (message.tool.state !== 'completed' && message.tool.state !== 'error' && message.tool.state !== 'running') {
            message.tool.state = 'running';
        }
    } else {
        // denied or canceled
        if (message.tool.state !== 'error' && message.tool.state !== 'completed') {
            message.tool.state = 'error';
            message.tool.completedAt = completed.completedAt || Date.now();
            if (!message.tool.result && completed.reason) {
                message.tool.result = { error: completed.reason };
            }
        }
    }
    return true;
}

function storedPermissionFrom(completed: NonNullable<AgentState['completedRequests']>[string]): StoredPermission {
    return {
        tool: completed.tool,
        arguments: completed.arguments,
        createdAt: completed.createdAt || Date.now(),
        completedAt: completed.completedAt || undefined,
        status: completed.status,
        reason: completed.reason || undefined,
        mode: completed.mode || undefined,
        allowedTools: completed.allowedTools || undefined,
        decision: completed.decision || undefined
    };
}

function planModeTransitionOf(msg: NormalizedMessage): PlanModeTransition | null {
    if (msg.role !== 'agent' || msg.isSidechain) return null;
    let transition: PlanModeTransition | null = null;
    for (const c of msg.content) {
        if (c.type !== 'tool-call') continue;
        if (c.name === 'EnterPlanMode' || c.name === 'enter_plan_mode') transition = 'enter';
        else if (c.name === 'ExitPlanMode' || c.name === 'exit_plan_mode') transition = 'exit';
    }
    return transition;
}

export function reducer(state: ReducerState, messages: NormalizedMessage[], agentState?: AgentState | null): ReducerResult {
    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Called with ${messages.length} messages, agentState: ${agentState ? 'YES' : 'NO'}`);
    }

    let newMessages: Message[] = [];
    let changed: Set<string> = new Set();
    let hasReadyEvent = false;

    // A message is FRESH when it is newer than everything projected before
    // this batch (or has no server seq yet — a live event). Only fresh
    // messages may report lifecycle transitions that change the current mode.
    const maxSeqBefore = state.maxSeq;
    const isFresh = (msg: NormalizedMessage) => msg.seq == null || maxSeqBefore == null || msg.seq > maxSeqBefore;
    const planMode: { current: { transition: PlanModeTransition; seq: number | null } | null } = { current: null };
    const notePlanMode = (msg: NormalizedMessage) => {
        if (!isFresh(msg)) return;
        const transition = planModeTransitionOf(msg);
        if (!transition) return;
        // Highest seq wins; a live (seq-less) transition is newest of all.
        const current = planMode.current;
        if (!current || msg.seq == null || (current.seq != null && msg.seq >= current.seq)) {
            planMode.current = { transition, seq: msg.seq ?? null };
        }
    };
    for (const msg of messages) {
        if (msg.seq != null && (state.maxSeq == null || msg.seq > state.maxSeq)) {
            state.maxSeq = msg.seq;
        }
    }

    // First, trace all messages to identify sidechains
    const tracedMessages = traceMessages(state.tracerState, messages);

    // Separate sidechain and non-sidechain messages
    let nonSidechainMessages = tracedMessages.filter(msg => !msg.sidechainId);
    const sidechainMessages = tracedMessages.filter(msg => msg.sidechainId);

    //
    // Phase 0.5: Message-to-Event Conversion
    // Convert event BLOCKS to events before normal processing; the remaining
    // blocks of the same message continue as an ordinary message.
    //

    const messagesToProcess: NormalizedMessage[] = [];
    const convertedEvents: { message: NormalizedMessage, event: AgentEvent }[] = [];

    for (const msg of nonSidechainMessages) {
        // Check if we've already processed this message
        if (msg.role === 'user' && msg.localId && state.localIds.has(msg.localId)) {
            reconcileSeq(state, changed, msg);
            continue;
        }
        if (state.messageIds.has(msg.id)) {
            reconcileSeq(state, changed, msg);
            continue;
        }

        // Turn usage rides on lifecycle events too (session-protocol turn-end
        // becomes `ready`); take it BEFORE the lifecycle filter below.
        if (msg.usage && msg.role !== 'agent') {
            processUsageData(state, msg.usage, msg.createdAt, msg.seq ?? null);
        }

        // Filter out ready events completely - they should not create any message
        if (msg.role === 'event' && msg.content.type === 'ready') {
            // Mark as processed to prevent duplication but don't add to messages
            state.messageIds.set(msg.id, msg.id);
            hasReadyEvent = true;
            continue;
        }

        // Session protocol turn-start markers are lifecycle-only and should stay invisible.
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Turn started') {
            state.messageIds.set(msg.id, msg.id);
            continue;
        }

        // Handle context reset events - reset state and let the message be shown.
        // A reset is a SNAPSHOT like any other and obeys the same seq/timestamp
        // ordering: paging history backward to an old "Context was reset" (seq
        // 10) used to unconditionally zero the current usage and empty the
        // todos recorded at seq 100, and dedup then prevented replaying the
        // newer data to repair the display (#391).
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Context was reset') {
            if (isLaterSnapshot(state.latestTodos, msg.seq ?? null, msg.createdAt)) {
                state.latestTodos = {
                    todos: [],
                    timestamp: msg.createdAt,  // Use message timestamp, not current time
                    seq: msg.seq ?? null
                };
            }
            if (isLaterSnapshot(state.latestUsage, msg.seq ?? null, msg.createdAt)) {
                state.latestUsage = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 0,
                    timestamp: msg.createdAt,  // Use message timestamp to avoid blocking older usage data
                    seq: msg.seq ?? null
                };
            }
            // Don't continue - let the event be processed normally to create a message
        }

        // Handle compaction completed events - reset context but keep todos
        // (same ordering rule as above, #391)
        if (msg.role === 'event' && msg.content.type === 'message' && msg.content.message === 'Compaction completed') {
            if (isLaterSnapshot(state.latestUsage, msg.seq ?? null, msg.createdAt)) {
                state.latestUsage = {
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 0,
                    timestamp: msg.createdAt,  // Use message timestamp to avoid blocking older usage data
                    seq: msg.seq ?? null
                };
            }
            // Don't continue - let the event be processed normally to create a message
        }

        // Plan-mode transitions are read from every fresh agent message,
        // whether or not its blocks convert to events.
        notePlanMode(msg);

        // Convert event blocks; keep the rest of the message.
        const { events, remainder } = splitMessageEvents(msg);
        for (const event of events) {
            convertedEvents.push({ message: msg, event });
        }
        if (events.length > 0 && remainder === null) {
            // Nothing but events: mark processed here (Phase 1 will not see it)
            // and take its usage.
            state.messageIds.set(msg.id, msg.id);
            if (msg.role === 'user' && msg.localId) {
                state.localIds.set(msg.localId, msg.id);
            }
            if (msg.role === 'agent' && msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt, msg.seq ?? null);
            }
        } else if (remainder) {
            messagesToProcess.push(remainder);
        }
    }

    // Process converted events immediately
    for (const { message, event } of convertedEvents) {
        const mid = allocateId();
        state.messages.set(mid, {
            id: mid,
            realID: message.id,
            seq: message.seq ?? null,
            role: 'agent',
            createdAt: message.createdAt,
            event: event,
            tool: null,
            text: null,
            meta: message.meta,
        });
        changed.add(mid);
    }

    // Update nonSidechainMessages to only include messages that weren't converted
    nonSidechainMessages = messagesToProcess;

    // Build a set of incoming tool IDs for quick lookup
    const incomingToolIds = new Set<string>();
    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    incomingToolIds.add(c.id);
                }
            }
        }
    }

    //
    // Phase 0: Process AgentState permissions
    //

    if (agentState) {
        // Process pending permission requests
        if (agentState.requests) {
            for (const [permId, request] of Object.entries(agentState.requests)) {
                // Skip if this permission is also in completedRequests (completed takes precedence)
                if (agentState.completedRequests && agentState.completedRequests[permId]) {
                    continue;
                }

                const rows = findToolRows(state, permId);
                if (rows.length > 0) {
                    // Update every row holding this call with the pending permission
                    for (const { mid, message } of rows) {
                        if (message.tool && !message.tool.permission) {
                            message.tool.permission = {
                                id: permId,
                                status: 'pending'
                            };
                            markChanged(state, changed, mid);
                        }
                    }
                } else {
                    // Create a new tool message for the permission request
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: request.tool,
                        state: 'running' as const,
                        input: request.arguments,
                        createdAt: request.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: null,
                        description: null,
                        result: undefined,
                        permission: {
                            id: permId,
                            status: 'pending'
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        // Permission placeholder from agentState — no server row
                        // yet, so it has no seq and sorts as newest until the
                        // matching tool-call event arrives with one.
                        seq: null,
                        role: 'agent',
                        createdAt: request.createdAt || Date.now(),
                        text: null,
                        tool: toolCall,
                        event: null,
                        callId: permId,
                    });

                    // Store by permission ID (which will match tool ID)
                    state.toolIdToMessageId.set(permId, mid);

                    changed.add(mid);
                }

                // Store permission details for quick lookup
                state.permissions.set(permId, {
                    tool: request.tool,
                    arguments: request.arguments,
                    createdAt: request.createdAt || Date.now(),
                    status: 'pending'
                });
            }
        }

        // Process completed permission requests
        if (agentState.completedRequests) {
            for (const [permId, completed] of Object.entries(agentState.completedRequests)) {
                const rows = findToolRows(state, permId);
                if (rows.length > 0) {
                    // Resolve EVERY copy — the root placeholder and a subagent's
                    // nested copy — and refresh the root that displays them.
                    let anyChanged = false;
                    for (const { mid, message } of rows) {
                        if (applyCompletedPermission(message, permId, completed)) {
                            anyChanged = true;
                            markChanged(state, changed, mid);
                        }
                    }
                    if (anyChanged) {
                        state.permissions.set(permId, storedPermissionFrom(completed));
                    }
                } else {
                    // No existing message - check if tool ID is in incoming messages
                    if (incomingToolIds.has(permId)) {
                        // Store permission for when tool arrives in Phase 2
                        state.permissions.set(permId, storedPermissionFrom(completed));
                        continue;
                    }

                    // Skip if already processed as pending
                    if (agentState.requests && agentState.requests[permId]) {
                        continue;
                    }

                    // Create a new message for completed permission without tool
                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: completed.tool,
                        state: completed.status === 'approved' ? 'completed' : 'error',
                        input: completed.arguments,
                        createdAt: completed.createdAt || Date.now(),
                        startedAt: null,
                        completedAt: completed.completedAt || Date.now(),
                        description: null,
                        result: completed.status === 'approved'
                            ? 'Approved'
                            : (completed.reason ? { error: completed.reason } : undefined),
                        permission: {
                            id: permId,
                            status: completed.status,
                            reason: completed.reason || undefined,
                            mode: completed.mode || undefined,
                            allowedTools: completed.allowedTools || undefined,
                            decision: completed.decision || undefined
                        }
                    };

                    state.messages.set(mid, {
                        id: mid,
                        realID: null,
                        seq: null,
                        role: 'agent',
                        createdAt: completed.createdAt || Date.now(),
                        text: null,
                        tool: toolCall,
                        event: null,
                        callId: permId,
                    });

                    state.toolIdToMessageId.set(permId, mid);
                    state.permissions.set(permId, storedPermissionFrom(completed));
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 1: Process non-sidechain user messages and text messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'user') {
            // Check if we've seen this localId before
            if (msg.localId && state.localIds.has(msg.localId)) {
                reconcileSeq(state, changed, msg);
                continue;
            }
            // Check if we've seen this message ID before
            if (state.messageIds.has(msg.id)) {
                reconcileSeq(state, changed, msg);
                continue;
            }

            // Create a new message
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                seq: msg.seq ?? null,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content.text,
                tool: null,
                event: null,
                meta: msg.meta,
                claudeUuid: msg.claudeUuid,
                ...(msg.content.isCompactSummary ? { isCompactSummary: true } : {}),
                ...(msg.content.attachments?.length ? { attachments: msg.content.attachments } : {}),
                ...(msg.meta?.deliveryStage ? { deliveryStage: msg.meta.deliveryStage } : {}),
                ...(msg.meta?.turnId ? { turnId: msg.meta.turnId } : {}),
            });

            // Track both localId and messageId
            if (msg.localId) {
                state.localIds.set(msg.localId, mid);
            }
            state.messageIds.set(msg.id, mid);
            if (msg.meta?.turnId) state.turnIds.set(msg.meta.turnId, mid);

            changed.add(mid);
        } else if (msg.role === 'agent') {
            // Check if we've seen this agent message before
            if (state.messageIds.has(msg.id)) {
                continue;
            }

            // Mark this message as seen
            state.messageIds.set(msg.id, msg.id);

            // Process usage data if present
            if (msg.usage) {
                processUsageData(state, msg.usage, msg.createdAt, msg.seq ?? null);
            }

            // Process text and thinking content (tool calls handled in Phase 2)
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    let mid = allocateId();
                    const isThinking = c.type === 'thinking';
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        seq: msg.seq ?? null,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: isThinking ? `*${c.thinking}*` : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                    });
                    changed.add(mid);
                } else if (c.type === 'user-text') {
                    // The user's own words riding in an array-form user record
                    // next to tool results — a user bubble, not agent text.
                    let mid = allocateId();
                    state.messages.set(mid, {
                        id: mid,
                        realID: msg.id,
                        seq: msg.seq ?? null,
                        role: 'user',
                        createdAt: msg.createdAt,
                        text: c.text,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                        claudeUuid: msg.claudeUuid,
                    });
                    changed.add(mid);
                }
            }
        }
    }

    //
    // Phase 2: Process non-sidechain tool calls
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-call') {
                    // Direct lookup by tool ID (since permission ID = tool ID now)
                    const existingMessageId = state.toolIdToMessageId.get(c.id);

                    if (existingMessageId) {
                        // Update existing row (a permission placeholder, or a
                        // duplicate observation of a known call) with the call's
                        // execution details AND its server identity.
                        const message = state.messages.get(existingMessageId);
                        if (message?.tool) {
                            // Merge idempotently: only a field that actually
                            // changes re-emits the row, so a replayed
                            // observation of a known call is a no-op.
                            let dirty = false;
                            if (message.realID === null) { message.realID = msg.id; dirty = true; }
                            if (msg.seq != null && message.seq !== msg.seq) { message.seq = msg.seq; dirty = true; }
                            if (!message.meta && msg.meta) { message.meta = msg.meta; dirty = true; }
                            if (message.callId !== c.id) { message.callId = c.id; dirty = true; }
                            state.messageIds.set(msg.id, existingMessageId);
                            const mergedInput = mergeToolInputs(message.tool.input, c.input);
                            if (JSON.stringify(mergedInput) !== JSON.stringify(message.tool.input)) { message.tool.input = mergedInput; dirty = true; }
                            if (message.tool.description !== c.description && c.description !== null) { message.tool.description = c.description; dirty = true; }
                            if (message.tool.startedAt === null) { message.tool.startedAt = msg.createdAt; dirty = true; }
                            // If permission was approved and shown as completed (no tool), now it's running
                            if (message.tool.permission?.status === 'approved' && message.tool.state === 'completed' && message.tool.result === 'Approved') {
                                message.tool.state = 'running';
                                message.tool.completedAt = null;
                                message.tool.result = undefined;
                                dirty = true;
                            }
                            if (applyPendingResult(state, c.id, message)) dirty = true;
                            if (dirty) changed.add(existingMessageId);
                        }
                    } else {
                        // Check if there's a stored permission for this tool
                        const permission = state.permissions.get(c.id);

                        let toolCall: ToolCall = {
                            name: c.name,
                            state: 'running' as const,
                            input: permission ? mergeToolInputs(permission.arguments, c.input) : c.input,
                            createdAt: permission ? permission.createdAt : msg.createdAt,  // Use permission timestamp if available
                            startedAt: msg.createdAt,
                            completedAt: null,
                            description: c.description,
                            result: undefined,
                        };

                        // Add permission info if found
                        if (permission) {
                            toolCall.permission = {
                                id: c.id,
                                status: permission.status,
                                reason: permission.reason,
                                mode: permission.mode,
                                allowedTools: permission.allowedTools,
                                decision: permission.decision
                            };

                            // Update state based on permission status
                            if (permission.status !== 'approved') {
                                toolCall.state = 'error';
                                toolCall.completedAt = permission.completedAt || msg.createdAt;
                                if (permission.reason) {
                                    toolCall.result = { error: permission.reason };
                                }
                            }
                        }

                        let mid = allocateId();
                        const row: ReducerMessage = {
                            id: mid,
                            realID: msg.id,
                            seq: msg.seq ?? null,
                            role: 'agent',
                            createdAt: msg.createdAt,
                            text: null,
                            tool: toolCall,
                            event: null,
                            meta: msg.meta,
                            callId: c.id,
                        };
                        state.messages.set(mid, row);

                        state.toolIdToMessageId.set(c.id, mid);
                        // Optimistic sends that normalize as agent TOOL-CALLS
                        // (file attachments) live under this allocated mid — map
                        // their localId here or the POST ack can't find them and
                        // their seq stays null forever (the seq-sort then floats
                        // the file bubble to "newest": stuck at the chat bottom).
                        if (msg.localId) {
                            state.localIds.set(msg.localId, mid);
                        }
                        // A result that arrived before this call settles it now.
                        applyPendingResult(state, c.id, row);
                        changed.add(mid);
                    }
                }
            }
        }
    }

    //
    // Phase 3: Process non-sidechain tool results
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'agent') {
            for (let c of msg.content) {
                if (c.type === 'tool-result') {
                    const observation: ToolResultObservation = {
                        content: c.content,
                        isError: c.is_error,
                        createdAt: msg.createdAt,
                        seq: msg.seq ?? null,
                        permissions: c.permissions,
                    };
                    rememberToolResult(state, c.tool_use_id, observation);
                    const rows = findToolRows(state, c.tool_use_id);
                    if (rows.length === 0) {
                        // The call is on a page not loaded yet — RETAIN the
                        // result; Phase 2 / Phase 4 apply it when the call lands.
                        if (!state.pendingResults.has(c.tool_use_id)) {
                            state.pendingResults.set(c.tool_use_id, observation);
                        }
                        continue;
                    }
                    for (const { mid, message } of rows) {
                        if (applyToolResult(state, message, observation)) {
                            markChanged(state, changed, mid);
                        }
                    }
                }
            }
        }
    }

    //
    // Phase 4: Process sidechains and store them in state
    //

    // For each sidechain message, store it in the state and mark the owning Task as changed
    for (const msg of sidechainMessages) {
        if (!msg.sidechainId) continue;

        // Skip if we already processed this message
        if (state.messageIds.has(msg.id)) continue;

        // Mark as processed
        state.messageIds.set(msg.id, msg.id);

        const ownerCallId = msg.sidechainId;
        // Get or create the sidechain array for this Task call
        const existingSidechain = state.sidechains.get(ownerCallId) || [];
        const owner = findToolRow(state, ownerCallId);
        const ownerPrompt = getVisibleSidechainPrompt(owner?.message ?? null);

        // Process and add new sidechain messages
        if (msg.role === 'agent' && msg.content[0]?.type === 'sidechain') {
            // This is the sidechain root - create a user message
            if (isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, msg.content[0].prompt)) {
                state.sidechains.set(ownerCallId, existingSidechain);
                continue;
            }
            let mid = allocateId();
            let userMsg: ReducerMessage = {
                id: mid,
                realID: msg.id,
                seq: msg.seq ?? null,
                role: 'user',
                createdAt: msg.createdAt,
                text: msg.content[0].prompt,
                tool: null,
                event: null,
                meta: msg.meta,
                ownerCallId,
            };
            state.messages.set(mid, userMsg);
            existingSidechain.push(userMsg);
        } else if (msg.role === 'agent') {
            // Process agent content in sidechain
            for (let c of msg.content) {
                if (c.type === 'text' || c.type === 'thinking') {
                    const text = c.type === 'thinking' ? c.thinking : c.text;
                    if (c.type === 'text' && isDuplicateSidechainPrompt(existingSidechain, ownerPrompt, text)) {
                        continue;
                    }
                    let mid = allocateId();
                    const isThinking = c.type === 'thinking';
                    let textMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        seq: msg.seq ?? null,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: isThinking ? `*${c.thinking}*` : c.text,
                        isThinking,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                        ownerCallId,
                    };
                    state.messages.set(mid, textMsg);
                    existingSidechain.push(textMsg);
                } else if (c.type === 'user-text') {
                    let mid = allocateId();
                    let userMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        seq: msg.seq ?? null,
                        role: 'user',
                        createdAt: msg.createdAt,
                        text: c.text,
                        tool: null,
                        event: null,
                        meta: msg.meta,
                        ownerCallId,
                    };
                    state.messages.set(mid, userMsg);
                    existingSidechain.push(userMsg);
                } else if (c.type === 'tool-call') {
                    const existingSidechainMid = state.sidechainToolIdToMessageId.get(c.id);
                    if (existingSidechainMid) {
                        // Duplicate observation of a nested call — merge into the row.
                        const existing = state.messages.get(existingSidechainMid);
                        if (existing?.tool) {
                            existing.tool.input = mergeToolInputs(existing.tool.input, c.input);
                            existing.tool.description = existing.tool.description ?? c.description;
                            if (msg.seq != null) existing.seq = msg.seq;
                            applyPendingResult(state, c.id, existing);
                        }
                        continue;
                    }

                    // Check if there's already a permission message for this tool
                    const existingPermissionMessageId = state.toolIdToMessageId.get(c.id);

                    let mid = allocateId();
                    let toolCall: ToolCall = {
                        name: c.name,
                        state: 'running' as const,
                        input: c.input,
                        createdAt: msg.createdAt,
                        startedAt: null,
                        completedAt: null,
                        description: c.description,
                        result: undefined
                    };

                    // If there's a permission message, copy its permission info
                    if (existingPermissionMessageId) {
                        const permissionMessage = state.messages.get(existingPermissionMessageId);
                        if (permissionMessage?.tool?.permission) {
                            toolCall.permission = { ...permissionMessage.tool.permission };
                            // Update the permission message to show it's running
                            if (permissionMessage.tool.state !== 'completed' && permissionMessage.tool.state !== 'error') {
                                permissionMessage.tool.state = 'running';
                                permissionMessage.tool.startedAt = msg.createdAt;
                                permissionMessage.tool.description = c.description;
                                changed.add(existingPermissionMessageId);
                            }
                        }
                    }

                    let toolMsg: ReducerMessage = {
                        id: mid,
                        realID: msg.id,
                        seq: msg.seq ?? null,
                        role: 'agent',
                        createdAt: msg.createdAt,
                        text: null,
                        tool: toolCall,
                        event: null,
                        meta: msg.meta,
                        callId: c.id,
                        ownerCallId,
                    };
                    state.messages.set(mid, toolMsg);
                    existingSidechain.push(toolMsg);

                    // Map sidechain tool separately to avoid overwriting permission mapping
                    state.sidechainToolIdToMessageId.set(c.id, mid);
                    applyPendingResult(state, c.id, toolMsg);
                } else if (c.type === 'tool-result') {
                    const observation: ToolResultObservation = {
                        content: c.content,
                        isError: c.is_error,
                        createdAt: msg.createdAt,
                        seq: msg.seq ?? null,
                        permissions: c.permissions,
                    };
                    // Update BOTH rows holding the call: the sidechain tool row
                    // and a root permission placeholder for it.
                    rememberToolResult(state, c.tool_use_id, observation);
                    const rows = findToolRows(state, c.tool_use_id);
                    if (rows.length === 0) {
                        if (!state.pendingResults.has(c.tool_use_id)) {
                            state.pendingResults.set(c.tool_use_id, observation);
                        }
                        continue;
                    }
                    for (const { mid, message } of rows) {
                        if (applyToolResult(state, message, observation)) {
                            markChanged(state, changed, mid);
                        }
                    }
                }
            }
        }

        // Update the sidechain in state
        state.sidechains.set(ownerCallId, existingSidechain);

        // Refresh the owning Task — every copy of it, through every nesting
        // level, to the root.
        markCallChanged(state, changed, ownerCallId);
    }

    //
    // Phase 5: Process mode-switch messages
    //

    for (let msg of nonSidechainMessages) {
        if (msg.role === 'event') {
            let mid = allocateId();
            state.messages.set(mid, {
                id: mid,
                realID: msg.id,
                seq: msg.seq ?? null,
                role: 'agent',
                createdAt: msg.createdAt,
                event: msg.content,
                tool: null,
                text: null,
                meta: msg.meta,
            });
            changed.add(mid);
        }
    }

    //
    // Collect changed messages (only root-level messages)
    //

    for (let id of changed) {
        let existing = state.messages.get(id);
        if (!existing) continue;
        // Only roots are emitted; a nested row is carried by its owner.
        if (existing.ownerCallId) continue;

        let message = convertReducerMessageToMessage(existing, state);
        if (message) {
            newMessages.push(message);
        }
    }

    if (ENABLE_LOGGING) {
        console.log(`[REDUCER] Changed messages: ${changed.size}`);
    }

    const planModeResult = planMode.current;
    return {
        messages: newMessages,
        todos: state.latestTodos?.todos,
        usage: state.latestUsage ? {
            inputTokens: state.latestUsage.inputTokens,
            outputTokens: state.latestUsage.outputTokens,
            cacheCreation: state.latestUsage.cacheCreation,
            cacheRead: state.latestUsage.cacheRead,
            contextSize: state.latestUsage.contextSize
        } : undefined,
        hasReadyEvent: hasReadyEvent || undefined,
        planModeTransition: planModeResult?.transition,
    };
}

//
// Helpers
//

function allocateId() {
    return Math.random().toString(36).substring(2, 15);
}

function processUsageData(state: ReducerState, usage: UsageData, timestamp: number, seq: number | null) {
    // Only update if this is newer than the current latest usage (seq-first).
    if (isLaterSnapshot(state.latestUsage, seq, timestamp)) {
        state.latestUsage = {
            inputTokens: usage.input_tokens,
            outputTokens: usage.output_tokens,
            cacheCreation: usage.cache_creation_input_tokens || 0,
            cacheRead: usage.cache_read_input_tokens || 0,
            contextSize: (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0) + usage.input_tokens,
            timestamp: timestamp,
            seq,
        };
    }
}


function convertReducerMessageToMessage(reducerMsg: ReducerMessage, state: ReducerState): Message | null {
    if (reducerMsg.role === 'user' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            seq: reducerMsg.seq,
            // Before the server acks (seq == null), realID holds the outbox
            // localId (a local send normalizes id === localId), so surface it —
            // the per-message delivery status uses it to resend idempotently.
            // After ack, realID is the server id, which the UI doesn't need.
            localId: reducerMsg.seq == null ? reducerMsg.realID : null,
            createdAt: reducerMsg.createdAt,
            kind: 'user-text',
            text: reducerMsg.text,
            ...(reducerMsg.meta?.displayText && { displayText: reducerMsg.meta.displayText }),
            ...(reducerMsg.claudeUuid && { claudeUuid: reducerMsg.claudeUuid }),
            ...(reducerMsg.isCompactSummary && { isCompactSummary: true }),
            ...(reducerMsg.attachments?.length ? { attachments: reducerMsg.attachments } : {}),
            ...(reducerMsg.deliveryStage ? { deliveryStage: reducerMsg.deliveryStage } : {}),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.text !== null) {
        return {
            id: reducerMsg.id,
            seq: reducerMsg.seq,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-text',
            text: reducerMsg.text,
            ...(reducerMsg.isThinking && { isThinking: true }),
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.tool !== null) {
        // Convert children recursively — keyed by THIS call's id
        let childMessages: Message[] = [];
        let children = reducerMsg.callId ? state.sidechains.get(reducerMsg.callId) || [] : [];
        for (let child of children) {
            let childMessage = convertReducerMessageToMessage(child, state);
            if (childMessage) {
                childMessages.push(childMessage);
            }
        }

        const tool: ToolCall = { ...reducerMsg.tool };
        tool.model = buildToolModel(tool, {
            callId: reducerMsg.callId ?? null,
            messageId: reducerMsg.realID,
            sessionId: state.sessionId,
            turnId: reducerMsg.meta?.turnId ?? null,
            parentCallId: reducerMsg.ownerCallId ?? null,
        });

        return {
            id: reducerMsg.id,
            seq: reducerMsg.seq,
            localId: null,
            createdAt: reducerMsg.createdAt,
            kind: 'tool-call',
            tool,
            children: childMessages,
            meta: reducerMsg.meta
        };
    } else if (reducerMsg.role === 'agent' && reducerMsg.event !== null) {
        return {
            id: reducerMsg.id,
            seq: reducerMsg.seq,
            createdAt: reducerMsg.createdAt,
            kind: 'agent-event',
            event: reducerMsg.event,
            meta: reducerMsg.meta
        };
    }

    return null;
}
