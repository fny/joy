import { AgentEvent, MessageAttachment } from "./typesRaw";
import { MessageMeta } from "./typesMessageMeta";
import type { ToolCallModel } from "./toolModel";

export type ToolCall = {
    name: string;
    state: 'running' | 'completed' | 'error';
    input: any;
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: any;
    permission?: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        reason?: string;
        mode?: string;
        allowedTools?: string[];
        decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        date?: number;
    };
    /**
     * Canonical normalized record (see sync/toolModel.ts). Attached by the
     * reducer at projection time; views read it through `getToolModel`, which
     * derives it for any legacy record that reaches them without one.
     */
    model?: ToolCallModel;
}

// Flattened message types - each message represents a single block
export type DeliveryStage = 'local' | 'relay' | 'daemon' | 'agent';

export type UserTextMessage = {
    kind: 'user-text';
    id: string;
    /**
     * Authoritative server log order for this message. Used as the primary
     * display sort key (createdAt mixes transcript-time and relay-time clocks
     * and is unreliable for ordering). Null for optimistic local sends that
     * have not yet been acked by the server.
     */
    seq?: number | null;
    localId: string | null;
    createdAt: number;
    text: string;
    displayText?: string; // Optional text to display in UI instead of actual text
    meta?: MessageMeta;
    /**
     * Claude conversation-file `uuid` corresponding to this message. Used as
     * the rewind point when forking / duplicating a session. Optional —
     * older messages and non-Claude agents may not have one.
     */
    claudeUuid?: string;
    /** Post-compaction summary — rendered as a collapsed block, not a bubble. */
    isCompactSummary?: boolean;
    /** How far a message THIS client sent has travelled. Absent for anything
     *  read back from history or sent elsewhere (renders as fully delivered).
     *    local  — in the chat, not yet accepted by the relay      (70%)
     *    relay  — the relay accepted it (POST ok / turn.queued)    (80%)
     *    daemon — the machine has it (turn.receipted)              (90%)
     *    agent  — typed into the agent and confirmed (turn.started)(100%) */
    deliveryStage?: DeliveryStage;
    /** Files sent with this prompt; bytes are fetched on demand by id. */
    attachments?: MessageAttachment[];
}

export type ModeSwitchMessage = {
    kind: 'agent-event';
    id: string;
    seq?: number | null;
    createdAt: number;
    event: AgentEvent;
    meta?: MessageMeta;
}

export type AgentTextMessage = {
    kind: 'agent-text';
    id: string;
    seq?: number | null;
    localId: string | null;
    createdAt: number;
    text: string;
    isThinking?: boolean;
    meta?: MessageMeta;
}

export type ToolCallMessage = {
    kind: 'tool-call';
    id: string;
    seq?: number | null;
    localId: string | null;
    createdAt: number;
    tool: ToolCall;
    children: Message[];
    meta?: MessageMeta;
}

/**
 * A span `(fromSeq, toSeq]` of history rows this device could not decrypt
 * with the key it had — `count` rows, as the relay reported them — kept by
 * the sync as a recoverable gap and re-read when the session key changes
 * (#128). Mirrored into the store for display only.
 */
export type UnopenableGapRange = {
    fromSeq: number;
    toSeq: number;
    count: number;
}

/**
 * The chat's placeholder for one {@link UnopenableGapRange}: "could not
 * decrypt N messages — will retry when keys change". SYNTHETIC — projected
 * from the gap ranges when the chat reads its messages (sync/unopenableGapRows),
 * never emitted by the reducer nor stored in a session's history.
 */
export type UnopenableGapMessage = {
    kind: 'unopenable-gap';
    id: string;
    /** The oldest seq of the span, so the row sorts where the gap begins. */
    seq: number;
    createdAt: number;
    count: number;
    fromSeq: number;
    toSeq: number;
}

export type Message = UserTextMessage | AgentTextMessage | ToolCallMessage | ModeSwitchMessage | UnopenableGapMessage;