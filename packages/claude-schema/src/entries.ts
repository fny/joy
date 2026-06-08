// All JSONL entry types in a Claude Code session transcript.
// One entry per line. Every entry has these shared fields:
import type { ContentBlock, Usage } from './content';

interface BaseEntry {
  uuid: string;
  timestamp: string;       // ISO 8601
  sessionId: string;
  // Present on most entries from the CLI
  version?: string;        // Claude Code version e.g. "2.1.139"
  userType?: 'external';
  entrypoint?: 'cli' | 'sdk-ts' | string;
  cwd?: string;
  gitBranch?: string;
}

// ── user ──────────────────────────────────────────────────────────────────────
// A message from the user: either plain text or tool results returned to Claude.

export interface UserEntry extends BaseEntry {
  type: 'user';
  parentUuid: string | null;   // uuid of prior assistant entry this replies to
  isSidechain: boolean;        // true for subagent conversations
  promptId?: string;           // unique ID for this prompt submission
  permissionMode?: string;     // e.g. "bypassPermissions" | "default"
  isMeta?: boolean;            // true for synthetic/injected messages (skip these)
  message: {
    role: 'user';
    // Simple text prompt — string when the user typed a message
    // Array when returning tool results to Claude
    content: string | ContentBlock[];
  };
  // Present when this is a tool result entry
  toolUseResult?: {
    stdout: string;
    stderr: string;
    interrupted: boolean;
    isImage: boolean;
    noOutputExpected: boolean;
  };
  sourceToolAssistantUUID?: string; // uuid of the assistant entry that called the tool
}

// ── assistant ─────────────────────────────────────────────────────────────────
// Claude's response. May contain text, thinking, tool calls, or a mix.

export interface AssistantEntry extends BaseEntry {
  type: 'assistant';
  parentUuid: string | null;
  isSidechain: boolean;
  requestId?: string;          // Anthropic API request ID e.g. "req_011Cb..."
  message: {
    id: string;                // Anthropic message ID e.g. "msg_01XN..."
    type: 'message';
    role: 'assistant';
    model: string;             // e.g. "claude-sonnet-4-6", "claude-opus-4-7"
    content: ContentBlock[];
    stop_reason: 'end_turn' | 'tool_use' | 'max_tokens' | string;
    stop_sequence: string | null;
    stop_details: unknown | null;
    usage: Usage;
    diagnostics?: unknown | null;
  };
}

// ── system ────────────────────────────────────────────────────────────────────
// Internal system events. Never shown to the user directly.

interface BaseSystemEntry extends BaseEntry {
  type: 'system';
  level?: 'info' | 'error' | 'suggestion' | 'warning';
  isMeta?: boolean;
}

export interface TurnDurationEntry extends BaseSystemEntry {
  subtype: 'turn_duration';
  durationMs: number;
  messageCount: number;   // number of API messages in the turn
}

export interface StopHookSummaryEntry extends BaseSystemEntry {
  subtype: 'stop_hook_summary';
  hookCount: number;
  hookInfos: Array<{ command: string; durationMs: number }>;
  hookErrors: unknown[];
  preventedContinuation: boolean;
  stopReason: string;
  hasOutput: boolean;
  toolUseID?: string;
}

export interface ApiErrorEntry extends BaseSystemEntry {
  subtype: 'api_error';
  error: {
    status: number;
    requestID?: string;
    error: { type: string; message: string };
    type: string;
  };
  retryInMs: number;
  retryAttempt: number;
  maxRetries: number;
}

export interface CompactBoundaryEntry extends BaseSystemEntry {
  subtype: 'compact_boundary';
  content: string;    // "Conversation compacted"
  compactMetadata: {
    trigger: 'auto' | 'manual';
    preTokens: number;
    preCompactDiscoveredTools: string[];
    postTokens: number;
    durationMs: number;
  };
}

export interface LocalCommandEntry extends BaseSystemEntry {
  subtype: 'local_command';
  // Raw XML-ish content: <command-name>/exit</command-name><command-message>...</command-message>
  content: string;
}

export type SystemEntry =
  | TurnDurationEntry
  | StopHookSummaryEntry
  | ApiErrorEntry
  | CompactBoundaryEntry
  | LocalCommandEntry;

// ── attachment ────────────────────────────────────────────────────────────────
// Context injected into the conversation by the harness (not typed by the user).

interface BaseAttachmentEntry extends BaseEntry {
  type: 'attachment';
}

export interface FileAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'file';
    filename: string;
    displayPath: string;
    content: {
      type: 'text';
      file: {
        filePath: string;
        content: string;
        numLines: number;
        startLine: number;
        totalLines: number;
      };
    };
  };
}

export interface EditedTextFileAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'edited_text_file';
    filename: string;
    // Line-numbered snippet: "1\tline one\n2\tline two\n..."
    snippet: string;
  };
}

export interface CompactFileReferenceAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'compact_file_reference';
    filename: string;
    displayPath: string;
  };
}

export interface DirectoryAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'directory';
    path: string;
    displayPath: string;
    content: string;
  };
}

export interface NestedMemoryAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'nested_memory';
    path: string;
    displayPath: string;
    content: {
      path: string;
      type: string;        // e.g. "Project"
      content: string;     // file contents
      contentDiffersFromDisk: boolean;
      parent: string;
    };
  };
}

export interface SkillListingAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'skill_listing';
    // Markdown list of available skills with descriptions
    content: string;
  };
}

export interface InvokedSkillsAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'invoked_skills';
    skills: Array<{
      name: string;
      path: string;   // e.g. "userSettings:discuss"
      content: string;
    }>;
  };
}

export interface DeferredToolsDeltaAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'deferred_tools_delta';
    addedNames: string[];
    addedLines: string[];
    removedNames: string[];
    readdedNames: string[];
    pendingMcpServers: string[];
  };
}

export interface McpInstructionsDeltaAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'mcp_instructions_delta';
    addedNames: string[];
    addedBlocks: string[];
    removedNames: string[];
  };
}

export interface CommandPermissionsAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'command_permissions';
    allowedTools: string[];
  };
}

export interface DateChangeAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'date_change';
    newDate: string;   // "YYYY-MM-DD"
  };
}

export interface TodoReminderAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'todo_reminder';
    itemCount: number;
    content: Array<{
      content: string;
      status: 'pending' | 'in_progress' | 'completed';
      activeForm: string;   // gerund form for display e.g. "Implementing feature X"
    }>;
  };
}

export interface TaskReminderAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'task_reminder';
    itemCount: number;
    content: Array<{
      id: string;
      subject: string;
      description: string;
      activeForm: string;
      status: 'pending' | 'in_progress' | 'completed';
      blocks: string[];
      blockedBy: string[];
    }>;
  };
}

export interface QueuedCommandAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'queued_command';
    // XML-wrapped task notification or similar queued input
    prompt: string;
    commandMode: 'task-notification' | string;
  };
}

export interface HookSuccessAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'hook_success';
    hookName: string;       // e.g. "Stop"
    toolUseID: string;
    hookEvent: string;
    content: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    command: string;
    durationMs: number;
  };
}

export interface HookErrorAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'hook_non_blocking_error';
    hookName: string;
    hookEvent: string;
    stdout: string;
    stderr: string;
    exitCode: number;
    command: string;
    durationMs: number;
  };
}

export interface PlanModeAttachment extends BaseAttachmentEntry {
  attachment: {
    type: 'plan_mode';
    reminderType: 'full' | 'brief';
    isSubAgent: boolean;
    planFilePath: string;
    planExists: boolean;
  };
}

export interface UltrathinkEffortAttachment extends BaseAttachmentEntry {
  attachment: { type: 'ultrathink_effort' };
}

export type AttachmentEntry =
  | FileAttachment
  | EditedTextFileAttachment
  | CompactFileReferenceAttachment
  | DirectoryAttachment
  | NestedMemoryAttachment
  | SkillListingAttachment
  | InvokedSkillsAttachment
  | DeferredToolsDeltaAttachment
  | McpInstructionsDeltaAttachment
  | CommandPermissionsAttachment
  | DateChangeAttachment
  | TodoReminderAttachment
  | TaskReminderAttachment
  | QueuedCommandAttachment
  | HookSuccessAttachment
  | HookErrorAttachment
  | PlanModeAttachment
  | UltrathinkEffortAttachment;

// ── other entry types ─────────────────────────────────────────────────────────

// Tracks file states so Claude Code can undo edits per-turn
export interface FileHistorySnapshotEntry extends BaseEntry {
  type: 'file-history-snapshot';
  messageId: string;
  isSnapshotUpdate: boolean;
  snapshot: {
    messageId: string;
    timestamp: string;
    trackedFileBackups: Record<string, {
      backupFileName: string;  // content-hash@vN
      version: number;
      backupTime: string;
    }>;
  };
}

// Written every time a message is enqueued for reliability (retry) handling
export interface QueueOperationEntry extends BaseEntry {
  type: 'queue-operation';
  operation: 'enqueue' | 'dequeue' | string;
  content: string;
}

// Claude's generated title for the session (updated after first exchange)
export interface AiTitleEntry extends BaseEntry {
  type: 'ai-title';
  aiTitle: string;
}

// Snapshot of the last user prompt text (used to restore draft on reload)
export interface LastPromptEntry extends BaseEntry {
  type: 'last-prompt';
  lastPrompt: string;
  leafUuid: string;   // uuid of the most recent leaf entry
}

// Permission mode in effect at this point in the session
export interface PermissionModeEntry extends BaseEntry {
  type: 'permission-mode';
  permissionMode: 'default' | 'bypassPermissions' | 'acceptEdits' | string;
}

// Conversation mode (e.g. plan mode toggled on/off)
export interface ModeEntry extends BaseEntry {
  type: 'mode';
  mode: 'normal' | 'plan' | string;
}

// ── union ─────────────────────────────────────────────────────────────────────

export type TranscriptEntry =
  | UserEntry
  | AssistantEntry
  | SystemEntry
  | AttachmentEntry
  | FileHistorySnapshotEntry
  | QueueOperationEntry
  | AiTitleEntry
  | LastPromptEntry
  | PermissionModeEntry
  | ModeEntry;
