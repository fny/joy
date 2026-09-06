import * as z from 'zod';
import { isCuid } from '@paralleldrive/cuid2';
import { MessageMetaSchema, MessageMeta } from './typesMessageMeta';

//
// Raw types
//

// Usage data type from Claude API
const usageDataSchema = z.object({
    input_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    output_tokens: z.number(),
    service_tier: z.string().optional(),
});

export type UsageData = z.infer<typeof usageDataSchema>;

const agentEventSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('switch'),
    mode: z.enum(['local', 'remote'])
}), z.object({
    type: z.literal('message'),
    message: z.string(),
}), z.object({
    type: z.literal('limit-reached'),
    endsAt: z.number(),
}), z.object({
    type: z.literal('ready'),
})]);
export type AgentEvent = z.infer<typeof agentEventSchema>;

const sessionTextEventSchema = z.object({
    t: z.literal('text'),
    text: z.string(),
    thinking: z.boolean().optional(),
});

const sessionServiceMessageEventSchema = z.object({
    t: z.literal('service'),
    text: z.string(),
});

const sessionToolCallStartEventSchema = z.object({
    t: z.literal('tool-call-start'),
    call: z.string(),
    name: z.string(),
    title: z.string(),
    description: z.string(),
    args: z.record(z.string(), z.unknown()),
});

const sessionToolCallEndEventSchema = z.object({
    t: z.literal('tool-call-end'),
    call: z.string(),
    // The tool's output (daemon-clamped) and whether it failed. Older daemons
    // send neither; the card then shows completion only, as before. Any
    // shape is accepted — a numeric or structured result is a valid result,
    // and rejecting it dropped the whole envelope.
    result: z.unknown().optional(),
    isError: z.boolean().optional(),
});

/** An attachment cited by a user message — the relay attachment id plus
 *  the display facts the sender embedded (see sync/v2/crypto V2Attachment). */
export const MessageAttachmentSchema = z.object({
    id: z.string(),
    name: z.string(),
    size: z.number(),
    mime: z.string().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    thumbhash: z.string().optional(),
});
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

const sessionTurnStartEventSchema = z.object({
    t: z.literal('turn-start'),
});

const sessionStartEventSchema = z.object({
    t: z.literal('start'),
    title: z.string().optional(),
});

const sessionTurnEndEventSchema = z.object({
    t: z.literal('turn-end'),
    status: z.enum(['completed', 'failed', 'cancelled']),
    usage: usageDataSchema.optional(), // joy-tmux carries the turn's token usage here
});

const sessionStopEventSchema = z.object({
    t: z.literal('stop'),
});

const sessionEventSchema = z.discriminatedUnion('t', [
    sessionTextEventSchema,
    sessionServiceMessageEventSchema,
    sessionToolCallStartEventSchema,
    sessionToolCallEndEventSchema,
    sessionTurnStartEventSchema,
    sessionStartEventSchema,
    sessionTurnEndEventSchema,
    sessionStopEventSchema,
]);

const sessionEnvelopeSchema = z.object({
    id: z.string(),
    time: z.number(),
    role: z.enum(['user', 'agent']),
    turn: z.string().optional(),
    subagent: z.string().refine((value) => isCuid(value), {
        message: 'subagent must be a cuid2 value',
    }).optional(),
    // Underlying agent-protocol message id (Claude's `uuid` in the JSONL)
    // — used as the rewind point for fork / duplicate. Optional for back-
    // compat with envelopes emitted before this field was wired through.
    claudeUuid: z.string().min(1).optional(),
    ev: sessionEventSchema,
}).superRefine((envelope, ctx) => {
    if (envelope.ev.t === 'service' && envelope.role !== 'agent') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'service events must use role "agent"',
            path: ['role'],
        });
    }
    if ((envelope.ev.t === 'start' || envelope.ev.t === 'stop') && envelope.role !== 'agent') {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${envelope.ev.t} events must use role "agent"`,
            path: ['role'],
        });
    }
});
type SessionEnvelope = z.infer<typeof sessionEnvelopeSchema>;

const rawTextContentSchema = z.object({
    type: z.literal('text'),
    text: z.string(),
}).passthrough();  // ROBUST: Accept unknown fields for future API compatibility
export type RawTextContent = z.infer<typeof rawTextContentSchema>;

const rawToolUseContentSchema = z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.any(),
}).passthrough();  // ROBUST: Accept unknown fields preserved by transform
export type RawToolUseContent = z.infer<typeof rawToolUseContentSchema>;

const rawToolResultContentSchema = z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    // Any shape a harness reports: a string, an ordered block list (text AND
    // image blocks), or structured output (Codex `{stdout, exitCode}` objects
    // arrive here through the hyphenated preprocess). A narrower schema
    // rejected the WHOLE record and dropped the message.
    content: z.unknown().optional(),
    is_error: z.boolean().optional(),
    permissions: z.object({
        date: z.number(),
        result: z.enum(['approved', 'denied']),
        mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'read-only', 'safe-yolo', 'yolo']).optional(),
        allowedTools: z.array(z.string()).optional(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
    }).optional(),
}).passthrough();  // ROBUST: Accept unknown fields for future API compatibility
export type RawToolResultContent = z.infer<typeof rawToolResultContentSchema>;

/**
 * Extended thinking content from Claude API
 * Contains model's reasoning process before generating the final response
 * Uses .passthrough() to preserve signature and other unknown fields
 */
const rawThinkingContentSchema = z.object({
    type: z.literal('thinking'),
    thinking: z.string(),
}).passthrough();  // ROBUST: Accept signature and future fields
export type RawThinkingContent = z.infer<typeof rawThinkingContentSchema>;

// ============================================================================
// WOLOG: Type-Safe Content Normalization via Zod Transform
// ============================================================================
// Accepts both hyphenated (Codex/Gemini) and underscore (Claude) formats
// Transforms all to canonical underscore format during validation
// Full type safety - no `unknown` types
// Source: Part D of the Expo Mobile Testing & Package Manager Agnostic System plan
// ============================================================================

/**
 * Hyphenated tool-call format from Codex/Gemini agents
 * Transforms to canonical tool_use format during validation
 * Uses .passthrough() to preserve unknown fields for future API compatibility
 */
const rawHyphenatedToolCallSchema = z.object({
    type: z.literal('tool-call'),
    callId: z.string(),
    id: z.string().optional(), // Some messages have both
    name: z.string(),
    input: z.any(),
}).passthrough();  // ROBUST: Accept and preserve unknown fields
type RawHyphenatedToolCall = z.infer<typeof rawHyphenatedToolCallSchema>;

/**
 * Hyphenated tool-call-result format from Codex/Gemini agents
 * Transforms to canonical tool_result format during validation
 * Uses .passthrough() to preserve unknown fields for future API compatibility
 */
const rawHyphenatedToolResultSchema = z.object({
    type: z.literal('tool-call-result'),
    callId: z.string(),
    tool_use_id: z.string().optional(), // Some messages have both
    output: z.any(),
    content: z.any().optional(), // Some messages have both
    is_error: z.boolean().optional(),
}).passthrough();  // ROBUST: Accept and preserve unknown fields
type RawHyphenatedToolResult = z.infer<typeof rawHyphenatedToolResultSchema>;

/**
 * Input schema accepting ALL formats (both hyphenated and canonical)
 * Including Claude's extended thinking content type
 */
const rawAgentContentInputSchema = z.discriminatedUnion('type', [
    rawTextContentSchema,           // type: 'text' (canonical)
    rawToolUseContentSchema,        // type: 'tool_use' (canonical)
    rawToolResultContentSchema,     // type: 'tool_result' (canonical)
    rawThinkingContentSchema,       // type: 'thinking' (canonical)
    rawHyphenatedToolCallSchema,    // type: 'tool-call' (hyphenated)
    rawHyphenatedToolResultSchema,  // type: 'tool-call-result' (hyphenated)
]);
type RawAgentContentInput = z.infer<typeof rawAgentContentInputSchema>;

/**
 * Type-safe transform: Hyphenated tool-call → Canonical tool_use
 * ROBUST: Unknown fields preserved via object spread and .passthrough()
 */
function normalizeToToolUse(input: RawHyphenatedToolCall) {
    // Spread preserves all fields from input (passthrough fields included)
    return {
        ...input,
        type: 'tool_use' as const,
        id: input.callId,  // Codex uses callId, canonical uses id
    };
}

/**
 * Type-safe transform: Hyphenated tool-call-result → Canonical tool_result
 * ROBUST: Unknown fields preserved via object spread and .passthrough()
 */
function normalizeToToolResult(input: RawHyphenatedToolResult) {
    // Spread preserves all fields from input (passthrough fields included)
    return {
        ...input,
        type: 'tool_result' as const,
        tool_use_id: input.callId,  // Codex uses callId, canonical uses tool_use_id
        content: input.output ?? input.content ?? '',  // Codex uses output, canonical uses content
        is_error: input.is_error ?? false,
    };
}

/**
 * Schema that accepts both hyphenated and canonical formats.
 * Normalization happens via .preprocess() at root level to avoid Zod v4 "unmergable intersection" issue.
 * See: https://github.com/colinhacks/zod/discussions/2100
 *
 * Accepts: 'text' | 'tool_use' | 'tool_result' | 'thinking' | 'tool-call' | 'tool-call-result'
 * All types validated by their respective schemas with .passthrough() for unknown fields
 */
const rawAgentContentSchema = z.union([
    rawTextContentSchema,
    rawToolUseContentSchema,
    rawToolResultContentSchema,
    rawThinkingContentSchema,
    rawHyphenatedToolCallSchema,
    rawHyphenatedToolResultSchema,
]);
export type RawAgentContent = z.infer<typeof rawAgentContentSchema>;

const rawAgentRecordSchema = z.discriminatedUnion('type', [z.object({
    type: z.literal('output'),
    data: z.intersection(z.discriminatedUnion('type', [
        z.object({ type: z.literal('system') }),
        z.object({ type: z.literal('result'), result: z.string().nullish(), subtype: z.string().nullish(), is_error: z.boolean().nullish() }),
        z.object({ type: z.literal('summary'), summary: z.string() }),
        z.object({ type: z.literal('assistant'), message: z.object({ role: z.literal('assistant'), model: z.string(), content: z.array(rawAgentContentSchema), usage: usageDataSchema.optional() }), parent_tool_use_id: z.string().nullable().optional() }),
        z.object({ type: z.literal('user'), message: z.object({ role: z.literal('user'), content: z.union([z.string(), z.array(rawAgentContentSchema)]) }), parent_tool_use_id: z.string().nullable().optional(), toolUseResult: z.any().nullable().optional() }),
    ]), z.object({
        isSidechain: z.boolean().nullish(),
        isCompactSummary: z.boolean().nullish(),
        isMeta: z.boolean().nullish(),
        uuid: z.string().nullish(),
        parentUuid: z.string().nullish(),
    }).passthrough()),  // ROBUST: Accept CLI metadata fields (userType, cwd, sessionId, version, gitBranch, slug, requestId, timestamp)
}), z.object({
    type: z.literal('event'),
    id: z.string(),
    data: agentEventSchema
}), z.object({
    type: z.literal('codex'),
    data: z.discriminatedUnion('type', [
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string() }),
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string()
        })
    ])
}), z.object({
    type: z.literal('session'),
    data: sessionEnvelopeSchema
}), z.object({
    // ACP (Agent Communication Protocol) - unified format for all agent providers
    type: z.literal('acp'),
    provider: z.enum(['gemini', 'codex', 'claude', 'opencode']),
    data: z.discriminatedUnion('type', [
        // Core message types
        z.object({ type: z.literal('reasoning'), message: z.string() }),
        z.object({ type: z.literal('message'), message: z.string() }),
        z.object({ type: z.literal('thinking'), text: z.string() }),
        // Tool interactions
        z.object({
            type: z.literal('tool-call'),
            callId: z.string(),
            input: z.any(),
            name: z.string(),
            id: z.string()
        }),
        z.object({
            type: z.literal('tool-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string(),
            isError: z.boolean().optional()
        }),
        // Hyphenated tool-call-result (for backwards compatibility with CLI)
        z.object({
            type: z.literal('tool-call-result'),
            callId: z.string(),
            output: z.any(),
            id: z.string()
        }),
        // File operations
        z.object({
            type: z.literal('file-edit'),
            description: z.string(),
            filePath: z.string(),
            diff: z.string().optional(),
            oldContent: z.string().optional(),
            newContent: z.string().optional(),
            id: z.string()
        }),
        // Terminal/command output
        z.object({
            type: z.literal('terminal-output'),
            data: z.string(),
            callId: z.string()
        }),
        // Task lifecycle events
        z.object({ type: z.literal('task_started'), id: z.string() }),
        z.object({ type: z.literal('task_complete'), id: z.string() }),
        z.object({ type: z.literal('turn_aborted'), id: z.string() }),
        // Permissions
        z.object({
            type: z.literal('permission-request'),
            permissionId: z.string(),
            toolName: z.string(),
            description: z.string(),
            options: z.any().optional()
        }),
        // Usage/metrics
        z.object({ type: z.literal('token_count') }).passthrough()
    ])
})]);

/**
 * Preprocessor: Normalizes hyphenated content types to canonical before validation
 * This avoids Zod v4's "unmergable intersection" issue with transforms inside complex schemas
 * See: https://github.com/colinhacks/zod/discussions/2100
 */
function preprocessMessageContent(data: any): any {
    if (!data || typeof data !== 'object') return data;

    // Helper: normalize a single content item
    const normalizeContent = (item: any): any => {
        if (!item || typeof item !== 'object') return item;

        if (item.type === 'tool-call') {
            return normalizeToToolUse(item);
        }
        if (item.type === 'tool-call-result') {
            return normalizeToToolResult(item);
        }
        return item;
    };

    // Normalize assistant message content
    if (data.role === 'agent' && data.content?.type === 'output' && data.content?.data?.message?.content) {
        if (Array.isArray(data.content.data.message.content)) {
            data.content.data.message.content = data.content.data.message.content.map(normalizeContent);
        }
    }

    // Normalize user message content
    if (data.role === 'agent' && data.content?.type === 'output' && data.content?.data?.type === 'user' && Array.isArray(data.content.data.message?.content)) {
        data.content.data.message.content = data.content.data.message.content.map(normalizeContent);
    }

    // Accept new session wrapper shape and normalize to canonical wrapped shape.
    // New shape:
    // { role: 'session', content: { id, role, turn?, subagent?, ev }, meta? }
    if (data.role === 'session' && data.content && typeof data.content === 'object') {
        const content = data.content as Record<string, unknown>;
        const looksLikeEnvelope = content.type !== 'session'
            && typeof content.id === 'string'
            && typeof content.role === 'string'
            && content.ev !== undefined;
        if (looksLikeEnvelope) {
            data.content = {
                type: 'session',
                data: content,
            };
        }
    }

    return data;
}

const rawRecordSchema = z.preprocess(
    preprocessMessageContent,
    z.discriminatedUnion('role', [
        z.object({
            role: z.literal('agent'),
            content: rawAgentRecordSchema,
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('user'),
            content: z.object({
                type: z.literal('text'),
                text: z.string(),
                attachments: z.array(MessageAttachmentSchema).optional(),
                // Post-compaction summary the daemon mirrors from the transcript.
                // Without this field zod strips the flag and the summary renders
                // as a wall-of-text user bubble instead of the collapsed card.
                isCompactSummary: z.boolean().optional(),
            }),
            meta: MessageMetaSchema.optional()
        }),
        z.object({
            role: z.literal('session'),
            content: z.object({
                type: z.literal('session'),
                data: sessionEnvelopeSchema
            }),
            meta: MessageMetaSchema.optional()
        })
    ])
);

export type RawRecord = z.infer<typeof rawRecordSchema>;

// Export schemas for validation
export const RawRecordSchema = rawRecordSchema;


//
// Normalized types
//

type NormalizedAgentContent =
    {
        type: 'text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'thinking';
        thinking: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-call';
        id: string;
        name: string;
        input: any;
        description: string | null;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'tool-result'
        tool_use_id: string;
        content: any;
        is_error: boolean;
        uuid: string;
        parentUUID: string | null;
        permissions?: {
            date: number;
            result: 'approved' | 'denied';
            mode?: string;
            allowedTools?: string[];
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
        };
    } | {
        /** User-authored text carried in an array-form user record next to
         *  tool results — rendered as the user's bubble, not agent text. */
        type: 'user-text';
        text: string;
        uuid: string;
        parentUUID: string | null;
    } | {
        type: 'summary',
        summary: string;
    } | {
        type: 'sidechain'
        uuid: string;
        prompt: string
    };

export type NormalizedMessage = ({
    role: 'user'
    content: {
        type: 'text';
        text: string;
        /** Files sent with the prompt (v2 sealed citations). */
        attachments?: MessageAttachment[];
        /** True for the synthetic post-compaction summary message — rendered
         *  as a collapsed block, not a normal user bubble. */
        isCompactSummary?: boolean;
    }
} | {
    role: 'agent'
    content: NormalizedAgentContent[]
} | {
    role: 'event'
    content: AgentEvent
}) & {
    id: string,
    localId: string | null,
    createdAt: number,
    /**
     * Authoritative server log sequence for this message (monotonic, gap-free
     * per session). Threaded through to the display sort key so ordering does
     * not depend on createdAt, which mixes transcript-time (agent envelopes)
     * and joyTime/relay-time (user messages). Null/undefined for locally
     * generated messages with no server row yet (optimistic sends, files).
     */
    seq?: number | null,
    isSidechain: boolean,
    meta?: MessageMeta,
    usage?: UsageData,
    /**
     * Underlying Claude `uuid` for this message — used as the rewind point
     * for the session fork / duplicate flow. Optional because some message
     * sources (legacy events, server-emitted control messages) have none.
     */
    claudeUuid?: string,
};

function normalizeSessionEnvelope(
    envelope: SessionEnvelope,
    localId: string | null,
    createdAt: number,
    meta: MessageMeta | undefined,
): NormalizedMessage | null {
    // Session protocol requires turn id on all agent-originated envelopes.
    // Drop malformed agent events without turn to avoid attaching stray messages.
    if (envelope.role === 'agent' && !envelope.turn) {
        return null;
    }

    const messageId = envelope.id;
    const messageCreatedAt = envelope.time;
    const parentUUID = envelope.subagent ?? null;
    const isSidechain = parentUUID !== null;
    const contentUUID = envelope.id;

    if (envelope.ev.t === 'turn-start') {
        return null;
    }

    if (envelope.ev.t === 'start' || envelope.ev.t === 'stop') {
        // Lifecycle marker for subagent boundaries; currently not rendered as chat content.
        return null;
    }

    if (envelope.ev.t === 'turn-end') {
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'event',
            isSidechain: false,
            content: { type: 'ready' },
            // Fold the turn's token usage (joy-tmux sessions show 0 otherwise) — the
            // reducer reads msg.usage regardless of role.
            usage: envelope.ev.usage,
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'service') {
        if (envelope.role !== 'agent') {
            return null;
        }

        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'text',
                text: envelope.ev.text,
                uuid: contentUUID,
                parentUUID
            }],
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'text') {
        if (envelope.role === 'user') {
            return {
                id: messageId,
                localId,
                createdAt: messageCreatedAt,
                role: 'user',
                isSidechain: false,
                content: {
                    type: 'text',
                    text: envelope.ev.text
                },
                meta,
                claudeUuid: envelope.claudeUuid,
            } satisfies NormalizedMessage;
        }

        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [
                envelope.ev.thinking ? {
                    type: 'thinking',
                    thinking: envelope.ev.text,
                    uuid: contentUUID,
                    parentUUID
                } : {
                    type: 'text',
                    text: envelope.ev.text,
                    uuid: contentUUID,
                    parentUUID
                }
            ],
            meta,
            claudeUuid: envelope.claudeUuid,
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'tool-call-start') {
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'tool-call',
                id: envelope.ev.call,
                name: envelope.ev.name || 'unknown',
                input: envelope.ev.args,
                description: envelope.ev.description,
                uuid: contentUUID,
                parentUUID
            }],
            meta
        } satisfies NormalizedMessage;
    }

    if (envelope.ev.t === 'tool-call-end') {
        return {
            id: messageId,
            localId,
            createdAt: messageCreatedAt,
            role: 'agent',
            isSidechain,
            content: [{
                type: 'tool-result',
                tool_use_id: envelope.ev.call,
                content: envelope.ev.result ?? null,
                is_error: envelope.ev.isError === true,
                uuid: contentUUID,
                parentUUID
            }],
            meta
        } satisfies NormalizedMessage;
    }

    return null;
}

/**
 * A tool_result's `content` as the reducer stores it: a string when the
 * harness sent a string or a text-only block list (EVERY text block joined in
 * order — the first block alone lost multi-file reads), the ordered block list
 * itself when it carries non-text blocks (images), or the structured value.
 * Zero, `false` and the empty string are valid results and survive as-is.
 */
export function normalizeToolResultContent(content: unknown): unknown {
    if (content === undefined || content === null) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const texts: string[] = [];
        let textOnly = true;
        for (const block of content) {
            if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string') {
                texts.push((block as { text: string }).text);
            } else if (typeof block === 'string') {
                texts.push(block);
            } else {
                textOnly = false;
            }
        }
        if (textOnly) return texts.join('\n');
        return content;
    }
    return content;
}

export function normalizeRawMessage(id: string, localId: string | null, createdAt: number, raw: RawRecord): NormalizedMessage | null {
    // Zod transform handles normalization during validation
    let parsed = rawRecordSchema.safeParse(raw);
    if (!parsed.success) {
        const rawObj = raw as any;
        const msgType = rawObj?.content?.data?.type ?? rawObj?.content?.type ?? 'unknown';
        console.warn(`Unrecognized message type: ${msgType} (id: ${id})`);
        return null;
    }
    raw = parsed.data;
    if (raw.role === 'user') {
        return {
            id,
            localId,
            // joy-tmux mirrors user messages with Claude's transcript timestamp
            // in meta.joyTime. Agent events already sort by their embedded
            // time, so honoring it here puts both on one clock — a --resume
            // replay sorts chronologically instead of splitting agent-then-user.
            createdAt: typeof raw.meta?.joyTime === 'number' ? raw.meta.joyTime : createdAt,
            role: 'user',
            content: raw.content,
            isSidechain: false,
            meta: raw.meta,
        };
    }
    if (raw.role === 'session') {
        return normalizeSessionEnvelope(
            raw.content.data,
            localId,
            createdAt,
            raw.meta,
        );
    }
    if (raw.role === 'agent') {
        if (raw.content.type === 'output') {

            // Skip Meta messages
            if (raw.content.data.isMeta) {
                return null;
            }

            // Compact summaries flow through as a collapsible user-text block
            // (flagged below). Any OTHER compact-summary shape stays dropped —
            // the summary is always a user message with string content.
            if (raw.content.data.isCompactSummary) {
                const d = raw.content.data;
                if (!(d.type === 'user' && d.message && typeof d.message.content === 'string')) {
                    return null;
                }
            }

            // Handle Result messages (e.g. slash command errors like "Unknown skill: mcp")
            if (raw.content.data.type === 'result') {
                const resultText = raw.content.data.result;
                if (resultText) {
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'agent',
                        content: [{
                            type: 'text' as const,
                            text: resultText,
                            uuid: raw.content.data.uuid ?? id,
                            parentUUID: raw.content.data.parentUuid ?? null,
                        }],
                        isSidechain: false,
                        meta: raw.meta,
                    } satisfies NormalizedMessage;
                }
                return null;
            }

            // Handle Assistant messages (including sidechains)
            if (raw.content.data.type === 'assistant') {
                if (!raw.content.data.uuid) {
                    return null;
                }
                let content: NormalizedAgentContent[] = [];
                for (let c of raw.content.data.message.content) {
                    if (c.type === 'text') {
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    } else if (c.type === 'thinking') {
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones (signature, etc.)
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    } else if (c.type === 'tool_use') {
                        let description: string | null = null;
                        if (typeof c.input === 'object' && c.input !== null && 'description' in c.input && typeof c.input.description === 'string') {
                            description = c.input.description;
                        }
                        content.push({
                            ...c,  // WOLOG: Preserve all fields including unknown ones
                            type: 'tool-call',
                            description,
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        } as NormalizedAgentContent);
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: raw.content.data.isSidechain ?? false,
                    content,
                    meta: raw.meta,
                    usage: raw.content.data.message.usage
                };
            } else if (raw.content.data.type === 'user') {
                if (!raw.content.data.uuid) {
                    return null;
                }

                // Array-form user content: text blocks are the user's words
                // (pasted images / expanded slash commands ship as blocks),
                // tool_result blocks are results. Both survive.
                const userTextBlocks: string[] = [];
                let userToolResultCount = 0;
                if (Array.isArray(raw.content.data.message?.content)) {
                    for (const c of raw.content.data.message.content) {
                        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0) {
                            userTextBlocks.push(c.text);
                        } else if (c.type === 'tool_result') {
                            userToolResultCount++;
                        }
                    }
                }
                const arrayUserText = userTextBlocks.length > 0 ? userTextBlocks.join('\n\n') : null;

                // Array-form sidechain root (Task prompt shipped as blocks).
                if (raw.content.data.isSidechain && arrayUserText !== null && userToolResultCount === 0) {
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'agent',
                        isSidechain: true,
                        content: [{
                            type: 'sidechain',
                            uuid: raw.content.data.uuid,
                            prompt: arrayUserText
                        }]
                    };
                }

                // Text-only array form is a plain user message.
                if (!raw.content.data.isSidechain && arrayUserText !== null && userToolResultCount === 0) {
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'user',
                        isSidechain: false,
                        content: {
                            type: 'text',
                            text: arrayUserText,
                            ...(raw.content.data.isCompactSummary ? { isCompactSummary: true } : {}),
                        },
                        claudeUuid: raw.content.data.uuid,
                    };
                }

                // Handle sidechain user messages
                if (raw.content.data.isSidechain && raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    // Return as a special agent message with sidechain content
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'agent',
                        isSidechain: true,
                        content: [{
                            type: 'sidechain',
                            uuid: raw.content.data.uuid,
                            prompt: raw.content.data.message.content
                        }]
                    };
                }

                // Handle regular user messages
                if (raw.content.data.message && typeof raw.content.data.message.content === 'string') {
                    return {
                        id,
                        localId,
                        createdAt,
                        role: 'user',
                        isSidechain: false,
                        content: {
                            type: 'text',
                            text: raw.content.data.message.content,
                            ...(raw.content.data.isCompactSummary ? { isCompactSummary: true } : {}),
                        },
                        claudeUuid: raw.content.data.uuid,
                    };
                }

                // Handle tool results
                let content: NormalizedAgentContent[] = [];
                if (typeof raw.content.data.message.content === 'string') {
                    content.push({
                        type: 'text',
                        text: raw.content.data.message.content,
                        uuid: raw.content.data.uuid,
                        parentUUID: raw.content.data.parentUuid ?? null
                    });
                } else {
                    for (let c of raw.content.data.message.content) {
                        if (c.type === 'tool_result') {
                            content.push({
                                ...c,  // WOLOG: Preserve all fields including unknown ones
                                type: 'tool-result',
                                content: raw.content.data.toolUseResult ? raw.content.data.toolUseResult : normalizeToolResultContent(c.content),
                                is_error: c.is_error || false,
                                uuid: raw.content.data.uuid,
                                parentUUID: raw.content.data.parentUuid ?? null,
                                permissions: c.permissions ? {
                                    date: c.permissions.date,
                                    result: c.permissions.result,
                                    mode: c.permissions.mode,
                                    allowedTools: c.permissions.allowedTools,
                                    decision: c.permissions.decision
                                } : undefined
                            } as NormalizedAgentContent);
                        }
                    }
                    if (arrayUserText !== null) {
                        content.push({
                            type: 'user-text',
                            text: arrayUserText,
                            uuid: raw.content.data.uuid,
                            parentUUID: raw.content.data.parentUuid ?? null
                        });
                    }
                }
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: raw.content.data.isSidechain ?? false,
                    content,
                    meta: raw.meta
                };
            }
        }
        if (raw.content.type === 'event') {
            return {
                id,
                localId,
                createdAt,
                role: 'event',
                content: raw.content.data,
                isSidechain: false,
            };
        }
        if (raw.content.type === 'codex') {
            if (raw.content.data.type === 'message') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                };
            }
            if (raw.content.data.type === 'reasoning') {
                // Cast codex messages to agent text messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call') {
                // Cast tool calls to agent tool-call messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.callId,
                        name: raw.content.data.name || 'unknown',
                        input: raw.content.data.input,
                        description: null,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call-result') {
                // Cast tool call results to agent tool-result messages
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
        }
        if (raw.content.type === 'session') {
            return normalizeSessionEnvelope(raw.content.data, localId, createdAt, raw.meta);
        }
        // ACP (Agent Communication Protocol) - unified format for all agent providers
        if (raw.content.type === 'acp') {
            if (raw.content.data.type === 'message') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'reasoning') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'text',
                        text: raw.content.data.message,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-call') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.callId,
                        name: raw.content.data.name || 'unknown',
                        input: raw.content.data.input,
                        description: null,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'tool-result') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: raw.content.data.isError ?? false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            // Handle hyphenated tool-call-result (backwards compatibility)
            if (raw.content.data.type === 'tool-call-result') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.output,
                        is_error: false,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'thinking') {
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'thinking',
                        thinking: raw.content.data.text,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'file-edit') {
                // Map file-edit to tool-call for UI rendering
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.id,
                        name: 'file-edit',
                        input: {
                            filePath: raw.content.data.filePath,
                            description: raw.content.data.description,
                            diff: raw.content.data.diff,
                            oldContent: raw.content.data.oldContent,
                            newContent: raw.content.data.newContent
                        },
                        description: raw.content.data.description,
                        uuid: raw.content.data.id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'terminal-output') {
                // Map terminal-output to tool-result
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-result',
                        tool_use_id: raw.content.data.callId,
                        content: raw.content.data.data,
                        is_error: false,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            if (raw.content.data.type === 'permission-request') {
                // Map permission-request to tool-call for UI to show permission dialog
                return {
                    id,
                    localId,
                    createdAt,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: raw.content.data.permissionId,
                        name: raw.content.data.toolName,
                        input: raw.content.data.options ?? {},
                        description: raw.content.data.description,
                        uuid: id,
                        parentUUID: null
                    }],
                    meta: raw.meta
                } satisfies NormalizedMessage;
            }
            // Task lifecycle events (task_started, task_complete, turn_aborted) and token_count
            // are status/metrics - skip normalization, they don't need UI rendering
        }
    }
    return null;
}
