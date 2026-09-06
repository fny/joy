import { z } from "zod";
import type { GitLineCount } from "./v2/machine";

/** True when a session was created by the joy machine daemon (joy-daemon).
 *  Accepts the historical values too — sessions created before the 2026-08
 *  renames ('joy-tmux', briefly 'joy-server') carry them in their server-side
 *  metadata forever. */
export function isJoyDaemonSource(source: string | null | undefined): boolean {
    return source === 'joy-daemon' || source === 'joy-server' || source === 'joy-tmux';
}

//
// Agent states
//

export const MetadataSchema = z.object({
    models: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentModelCode: z.string().optional(),
    operatingModes: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentOperatingModeCode: z.string().optional(),
    thoughtLevels: z.array(z.object({
        code: z.string(),
        value: z.string(),
        description: z.string().nullish(),
    })).optional(),
    currentThoughtLevelCode: z.string().optional(),
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    // v2 nucleus linkage (stamped by the daemon's lane at bind): this session's
    // writes route over the v2 plane; keyEnvelope carries the sealed content key.
    v2: z.object({
        sessionId: z.string(),
        relay: z.string(),
        keyEnvelope: z.string(),
        /** Daemon-local session id — addresses the machine plane over the tunnel. */
        localSessionId: z.string().optional(),
    }).optional(),
    claudeSessionId: z.string().optional(), // Claude Code session ID
    codexThreadId: z.string().optional(), // Codex app-server thread ID
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).optional(),
    skills: z.array(z.string()).optional(),
    homeDir: z.string().optional(), // User's home directory on the machine
    startedFromDaemon: z.boolean().optional(),
    hostPid: z.number().optional(), // Process ID of the session
    startedBy: z.enum(['daemon', 'terminal']).optional(),
    flavor: z.string().nullish(), // Session flavor/variant identifier
    sandbox: z.any().nullish(), // Sandbox config metadata from CLI (or null when disabled)
    dangerouslySkipPermissions: z.boolean().nullish(), // Claude --dangerously-skip-permissions mode (or null when unknown)
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    /**
     * Lineage for sessions created via the fork / duplicate flow.
     * `parentSessionId` is the session this one was branched from.
     * `forkedFromMessageId` is the in-app message id used as the rewind
     * point (only set for "duplicate from message", not for plain fork).
     * Both ride inside encrypted metadata so the server stays oblivious.
     */
    parentSessionId: z.string().optional(),
    forkedFromMessageId: z.string().optional(),
    // 'joy-daemon' — see isJoyDaemonSource() for historical values
    joy__source: z.string().optional(),
    joy__sessionId: z.string().optional(), // tmux session ID on the joy daemon
    joy__state: z.enum(['running', 'detached', 'archived']).optional(), // joy lifecycle: detached = Claude died (red status)
    // joy: a 500-error auto-retry is in progress (daemon re-sending a failed
    // turn on a backoff schedule). Drives the "retrying" status. null/absent = none.
    joy__retry: z.object({
        attempt: z.number(),
        total: z.number(),
        nextAt: z.number(),
        status: z.number(),
    }).nullable().optional(),
    // joy: the daemon's message queue, pushed via metadata so the app doesn't
    // have to poll joy-queue-list. queue = lined-up messages; inFlight = the one
    // typed-but-not-confirmed; paused = auto-drain halted after a failed dispatch;
    // pauseReason = why it's halted (dirty input box vs a dispatch timeout/mismatch),
    // for a precise banner.
    joy__queue: z.object({
        queue: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.number() })),
        pendingCount: z.number().optional(),
        hidden: z.array(z.object({ id: z.string(), text: z.string(), createdAt: z.number() })).optional(),
        inFlight: z.string().nullable(),
        paused: z.boolean(),
        pauseReason: z.enum(['input_dirty', 'dispatch_timeout', 'dispatch_mismatch', 'dispatch_failed']).optional(),
    }).nullable().optional(),
    // joy: Claude is compacting its context (summarizing the conversation to free
    // tokens). Set by the daemon's PreCompact hook, cleared by the compact_boundary
    // transcript marker. Drives the "compacting" status. null/absent = none.
    joy__compacting: z.object({
        trigger: z.enum(['auto', 'manual']),
        since: z.number(),
    }).nullable().optional(),
    // joy: the relay refused this session's further output for good (429
    // session_event_budget_exhausted — 50,000 events per session, never
    // refilled; #130). The daemon drops that output and counts it here:
    // `dropped` records lost since `since`. Drives the persistent EventBudgetBar
    // and the sidebar marker; the only recovery is a new session. Stays set
    // for the life of the session (the daemon re-asserts it across restarts).
    joy__eventBudget: z.object({
        since: z.number(),
        dropped: z.number(),
    }).nullable().optional(),
    // Persisted mirror of the ephemeral thinking flag (the ephemeral only
    // reaches connected clients, so a cold app start lost the state until the
    // next 30s keepalive). Only trusted while the session's presence is live.
    joy__thinking: z.object({
        since: z.number(),
    }).nullable().optional(),
    // joy: background tasks (run_in_background bash / agents) in flight, tracked
    // by the daemon from the transcript. Drives a continuous "N/M completed"
    // working status that outlives the foreground turn. null/absent = none.
    joy__tasks: z.object({
        done: z.number(),
        total: z.number(),
    }).nullable().optional(),
    // Background AGENTS (async Task-tool agents) — magenta N/M, ranks above
    // joy__tasks (shell/bash finishing tasks, teal).
    joy__agents: z.object({ done: z.number(), total: z.number() }).nullable().optional(),

    // Count of live long-running background processes (servers/daemons the agent
    // tagged <joy-bg long-running>). These never "complete", so they're kept OUT
    // of joy__tasks (the N/M) and shown as plain text next to the status.
    joy__longRunning: z.number().nullable().optional(),
    // Context tokens used as of the latest turn (input + cache-read + cache-create
    // from the transcript's cumulative usage), reported by joy-tmux. The app owns
    // the window/threshold; this is just the raw count. Not yet surfaced in the UI.
    joy__context: z.number().nullable().optional(),
    // The agent's active /goal (Claude goal_status), surfaced by joy-tmux. Drives
    // the goal bar. Present while a goal is in progress; cleared when met.
    joy__handoff: z.object({
        state: z.string(),
        peer: z.string().optional(),
        peerLabel: z.string().optional(),
        note: z.string().optional(),
        error: z.string().optional(),
        at: z.number(),
    }).passthrough().nullable().optional(),
    joy__goal: z.object({
        condition: z.string(),
        since: z.number().optional(),
    }).nullable().optional(),
    // An interactive auth/login URL the agent's CLI is showing in its pane (e.g.
    // Claude Code's /login OAuth flow), surfaced by joy-tmux. Drives the login
    // bar; the app submits the pasted code via `/login-code <code>`. Present
    // while the prompt is up, cleared when it's gone.
    joy__login: z.object({
        url: z.string(),
        since: z.number().optional(),
        error: z.string().optional(), // rejection message (e.g. bad/expired code)
    }).nullable().optional(),
    // Interactive CLI dialog occupying the pane (model picker, "Switch model?"
    // confirm, /effort slider…) — the harness is waiting on a human in the
    // terminal, not Claude. Drives the "answer this in the terminal" banner.
    joy__dialog: z.object({
        title: z.string().nullable().optional(),
        options: z.array(z.string()),
        since: z.number().optional(),
    }).nullable().optional(),
    // A codex approval request (non-yolo): the agent wants to run a command or
    // apply a patch and is waiting for the user to Allow/Deny.
    joy__codexApproval: z.object({
        requestId: z.string(),
        kind: z.enum(['command', 'patch']),
        title: z.string(),
        detail: z.string().optional(),
        since: z.number().optional(),
    }).nullable().optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish()
    })).nullish(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.any(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().nullish(),
        mode: z.string().nullish(),
        allowedTools: z.array(z.string()).nullish(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).nullish()
    })).nullish()
});

export type AgentState = z.infer<typeof AgentStateSchema>;

export const TodoItemSchema = z.object({
    content: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed']),
    priority: z.enum(['high', 'medium', 'low']).optional(),
    id: z.string().optional(),
});

export const TodoItemsSchema = z.array(TodoItemSchema);

export type TodoItem = z.infer<typeof TodoItemSchema>;

export interface Session {
    id: string,
    seq: number,
    createdAt: number,
    updatedAt: number,
    active: boolean,
    activeAt: number,
    metadata: Metadata | null,
    metadataVersion: number,
    agentState: AgentState | null,
    agentStateVersion: number,
    thinking: boolean,
    thinkingAt: number,
    presence: "online" | number, // "online" when active, timestamp when last seen
    todos?: TodoItem[];
    draft?: string | null; // Local draft message, not synced to server
    permissionMode?: string | null; // Local permission mode key, not synced to server
    modelMode?: string | null; // Local model key, not synced to server
    effortLevel?: string | null; // Local effort level key, not synced to server
    // IMPORTANT: latestUsage is extracted from reducerState.latestUsage after message processing.
    // We store it directly on Session to ensure it's available immediately on load.
    // Do NOT store reducerState itself on Session - it's mutable and should only exist in SessionMessages.
    latestUsage?: {
        inputTokens: number;
        outputTokens: number;
        cacheCreation: number;
        cacheRead: number;
        contextSize: number;
        timestamp: number;
    } | null;
}

export interface DecryptedMessage {
    id: string,
    seq: number | null,
    localId: string | null,
    content: any,
    createdAt: number,
}

//
// Machine states
//

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    // Sent by joy-daemon (server.ts machineMetadata). All optional so machines
    // registered by a not-yet-updated daemon still parse and list.
    joyDaemonVersion: z.string().optional(),
    homeDir: z.string().optional(), // User's home directory
    joyHomeDir: z.string().optional(), // The daemon's relay credentials dir (~/.joy/relays/<relay>/)
    joyLibDir: z.string().optional(), // Where the running daemon's code lives
    // Optional fields that may be added in future versions
    username: z.string().optional(),
    arch: z.string().optional(),
    displayName: z.string().optional(), // Custom display name for the machine
    // Slash commands joy-tmux discovered on this machine (personal + plugins +
    // every project it has scanned). Powers the machine page's command list.
    slashCommands: z.array(z.string()).optional(),
    // The plugin-only subset of slashCommands — plugins are always excluded from
    // the composer/autocomplete; this set is how the app identifies them (they
    // can't be told apart from project commands by name alone).
    pluginSlashCommands: z.array(z.string()).optional(),
    // name → frontmatter `description:` for discovered custom commands/skills,
    // so the autocomplete can show real descriptions when available.
    slashCommandDescriptions: z.record(z.string(), z.string()).optional(),
    // Daemon status fields
    daemonLastKnownStatus: z.enum(['running', 'shutting-down']).optional(),
    daemonLastKnownPid: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.enum(['joy-app', 'joy-daemon', 'os-signal', 'unknown']).optional(),
    cliAvailability: z.object({
        claude: z.boolean(),
        codex: z.boolean(),
        gemini: z.boolean(),
        openclaw: z.boolean(),
        opencode: z.boolean().optional(),
        pi: z.boolean().optional(),
        detectedAt: z.number(),
    }).optional(),
    // The daemon's feature advertisement (relay.ts #upsertMachine). Absent on
    // a daemon that predates it — every flag reads as off, never as an error.
    capabilities: z.object({
        // The nucleus lane opens `v2e1:` spawn specs sealed under the machine's
        // "Joy Spawn Spec" key, so v2SpawnAndWait seals instead of sending the
        // plain JSON an older daemon needs (#107, sync/v2/spawnSpec.ts).
        spawnSpecSealed: z.boolean().optional(),
    }).optional(),
});

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>;

export interface Machine {
    id: string;
    seq: number;
    createdAt: number;
    updatedAt: number;
    active: boolean;
    activeAt: number;  // Changed from lastActiveAt to activeAt for consistency
    /** v2 lease liveness from the relay — the same authority the work queue
     *  trusts. When present it wins over activeAt-freshness heuristics. */
    leaseAlive?: boolean;
    metadata: MachineMetadata | null;
    metadataVersion: number;
    daemonState: any | null;  // Dynamic daemon state (runtime info)
    daemonStateVersion: number;
}

//
// Git Status
//

export interface GitStatus {
    /** Branch name (the unborn branch's name before the first commit); null when detached. */
    branch: string | null;
    head: 'branch' | 'detached' | 'unborn';
    isDirty: boolean;
    modifiedCount: number;
    untrackedCount: number;
    stagedCount: number;
    conflictedCount: number;
    lastUpdatedAt: number;
    // Line change statistics per side: exact counts from the daemon's structured
    // status, or 'unavailable' when they could not be read — never a stand-in zero.
    stagedLines: GitLineCount;
    unstagedLines: GitLineCount;
    /** staged + unstaged; 'unavailable' when either side is. */
    totalLines: GitLineCount;
    // Branch tracking information
    upstreamBranch?: string | null; // Name of upstream branch
    aheadCount?: number | null; // Commits ahead of upstream (null: upstream gone)
    behindCount?: number | null; // Commits behind upstream
    stashCount?: number; // Number of stash entries
}
