/**
 * Event catalog — comm-layer-spec §9. Discriminated union over `type` with a
 * typed payload per variant. The envelope (§7) carries one of these as its
 * payload-shaped body; this module models the body itself.
 *
 * Idempotency classes (informative):
 *   K = dedupe by eventId
 *   T = turn-scoped, fold idempotent by (turnId, state)
 *   R = request/response keyed by reqId
 */
import { z } from 'zod';

// ── Input events (producer: app) ────────────────────────────────────────────

export const UserMessageEvent = z.object({
    type: z.literal('user-message'),
    payload: z.object({
        messageId: z.string().min(1),
        content: z.unknown(),
        attachments: z.array(z.unknown()).optional(),
    }),
});

export const SteerEvent = z.object({
    type: z.literal('steer'),
    payload: z.object({
        targetTurnId: z.string().min(1),
        content: z.unknown(),
    }),
});

export const CancelEvent = z.object({
    type: z.literal('cancel'),
    /** targetTurnId: a turn id, or `"*"`/null to cancel current + drain pending. */
    payload: z.object({
        targetTurnId: z.union([z.string().min(1), z.literal('*'), z.null()]),
    }),
});

export const InterruptEvent = z.object({
    type: z.literal('interrupt'),
    payload: z.object({ targetTurnId: z.string().min(1) }),
});

export const ModeChangeEvent = z.object({
    type: z.literal('mode-change'),
    payload: z.object({
        permissionMode: z.string().optional(),
        model: z.string().optional(),
    }),
});

// ── Lease (producer: daemon) ────────────────────────────────────────────────

export const WriterClaimEvent = z.object({
    type: z.literal('writer-claim'),
    payload: z.object({
        daemonId: z.string().min(1),
        epoch: z.number().int().positive(),
    }),
});

// ── Turn lifecycle (producer: daemon / agent writer) ────────────────────────

export const TurnStartedEvent = z.object({
    type: z.literal('turn-started'),
    payload: z.object({
        turnId: z.string().min(1),
        requestEventId: z.string().min(1),
    }),
});

export const TurnOutputEvent = z.object({
    type: z.literal('turn-output'),
    payload: z.object({
        turnId: z.string().min(1),
        messageId: z.string().min(1),
        content: z.unknown(),
    }),
});

export const ToolCallEvent = z.object({
    type: z.literal('tool-call'),
    payload: z.object({
        turnId: z.string().min(1),
        toolCallId: z.string().min(1),
        name: z.string().min(1),
        input: z.unknown(),
        state: z.enum(['pending', 'running']),
    }),
});

export const ToolResultEvent = z.object({
    type: z.literal('tool-result'),
    payload: z.object({
        turnId: z.string().min(1),
        toolCallId: z.string().min(1),
        ok: z.boolean(),
        result: z.unknown().optional(),
        error: z.unknown().optional(),
        parts: z.object({
            partIdx: z.number().int().nonnegative(),
            last: z.boolean(),
        }).optional(),
    }),
});

export const TurnCompletedEvent = z.object({
    type: z.literal('turn-completed'),
    payload: z.object({
        turnId: z.string().min(1),
        usage: z.unknown().optional(),
        costUsd: z.number().optional(),
    }),
});

export const TurnFailedEvent = z.object({
    type: z.literal('turn-failed'),
    payload: z.object({
        turnId: z.string().min(1),
        errorSubtype: z.string().min(1),
        detail: z.unknown().optional(),
    }),
});

export const TurnCancelledEvent = z.object({
    type: z.literal('turn-cancelled'),
    payload: z.object({
        turnId: z.string().min(1),
        by: z.string().min(1),
    }),
});

export const TurnInterruptedEvent = z.object({
    type: z.literal('turn-interrupted'),
    payload: z.object({
        turnId: z.string().min(1),
        reason: z.enum(['crash', 'interrupt']),
    }),
});

// ── Background tasks (producer: daemon) ─────────────────────────────────────

export const BgStartedEvent = z.object({
    type: z.literal('bg-started'),
    payload: z.object({
        taskId: z.string().min(1),
        turnId: z.string().min(1),
        label: z.string(),
    }),
});

export const BgProgressEvent = z.object({
    type: z.literal('bg-progress'),
    payload: z.object({
        taskId: z.string().min(1),
        usage: z.unknown().optional(),
    }),
});

export const BgNotificationEvent = z.object({
    type: z.literal('bg-notification'),
    payload: z.object({
        taskId: z.string().min(1),
        status: z.enum(['completed', 'failed', 'stopped']),
    }),
});

export const BgExitedEvent = z.object({
    type: z.literal('bg-exited'),
    payload: z.object({
        taskId: z.string().min(1),
        reason: z.string(),
    }),
});

// ── Permission / elicitation ────────────────────────────────────────────────

export const PermissionRequestEvent = z.object({
    type: z.literal('permission-request'),
    payload: z.object({
        reqId: z.string().min(1),
        turnId: z.string().min(1),
        toolCall: z.unknown(),
        options: z.array(z.unknown()),
    }),
});

export const PermissionResponseEvent = z.object({
    type: z.literal('permission-response'),
    payload: z.object({
        reqId: z.string().min(1),
        optionId: z.string().min(1),
        auto: z.boolean().optional(),
    }),
});

// ── Metadata, liveness, snapshot, dead-letter, observability ────────────────

export const AgentMetadataEvent = z.object({
    type: z.literal('agent-metadata'),
    payload: z.object({
        tools: z.array(z.string()).optional(),
        slashCommands: z.array(z.string()).optional(),
        models: z.array(z.string()).optional(),
        mcpServers: z.array(z.unknown()).optional(),
        skills: z.array(z.unknown()).optional(),
    }),
});

export const HeartbeatEvent = z.object({
    type: z.literal('heartbeat'),
    payload: z.object({
        turnId: z.string().min(1),
        hbCounter: z.number().int().nonnegative(),
    }),
});

export const CursorEvent = z.object({
    type: z.literal('cursor'),
    payload: z.object({ appliedSeq: z.number().int().nonnegative() }),
});

export const SnapshotEvent = z.object({
    type: z.literal('snapshot'),
    payload: z.object({
        uptoSeq: z.number().int().nonnegative(),
        projection: z.unknown(),
    }),
});

export const RejectedEvent = z.object({
    type: z.literal('rejected'),
    payload: z.object({
        refEventId: z.string().min(1),
        reason: z.string(),
    }),
});

export const ProjectionDigestEvent = z.object({
    type: z.literal('projection-digest'),
    payload: z.object({
        uptoSeq: z.number().int().nonnegative(),
        hash: z.string().min(1),
    }),
});

// ── Union ───────────────────────────────────────────────────────────────────

export const AnyEventSchema = z.discriminatedUnion('type', [
    UserMessageEvent,
    SteerEvent,
    CancelEvent,
    InterruptEvent,
    ModeChangeEvent,
    WriterClaimEvent,
    TurnStartedEvent,
    TurnOutputEvent,
    ToolCallEvent,
    ToolResultEvent,
    TurnCompletedEvent,
    TurnFailedEvent,
    TurnCancelledEvent,
    TurnInterruptedEvent,
    BgStartedEvent,
    BgProgressEvent,
    BgNotificationEvent,
    BgExitedEvent,
    PermissionRequestEvent,
    PermissionResponseEvent,
    AgentMetadataEvent,
    HeartbeatEvent,
    CursorEvent,
    SnapshotEvent,
    RejectedEvent,
    ProjectionDigestEvent,
]);
export type AnyEvent = z.infer<typeof AnyEventSchema>;

/** Set of currently-known control event types (carry `vmin`, spec §7). */
export const CONTROL_EVENT_TYPES = new Set<string>([
    'cancel',
    'interrupt',
    'steer',
    'permission-response',
    'mode-change',
    'writer-claim',
]);
