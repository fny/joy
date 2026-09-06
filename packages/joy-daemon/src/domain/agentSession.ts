// The structural interface the registry, operations, and relay-attach code use
// to drive a session, regardless of agent type. Extracted from the claude
// `Session`'s external surface (the methods/getters called from OUTSIDE the
// class) so that both `Session` (claude) and `CodexSession` satisfy it — the
// claude Session satisfies it implicitly (structural typing; zero behavior
// change). Registry constructs one or the other based on the persisted `agent`
// field and holds them all as `AgentSession`.
//
// Types are imported from their canonical homes; the claude-session types are
// type-only imports (erased at runtime — no dependency cycle).

import type { RelaySession } from "../relay/relay";
import type { DeliverySource } from "./receipts";
import type { SessionStatus, SessionRecord, QueuedMessage, QueueState, QueueItemState } from "../claude/session";

export interface AgentSession {
  /** Which harness runs this session — drives per-flavor projections
   *  (e.g. the slash-command palette). */
  readonly agentFlavor: "claude" | "codex" | "opencode" | "pi" | "agy";
  // ── identity / state (read by registry + operations) ──
  readonly id: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
  status: SessionStatus;
  endReason?: string;
  /** Claude transcript/session uuid — undefined for codex (uses a thread id). */
  claudeSessionId?: string;
  /** On-disk transcript/rollout path, if any. */
  transcriptPath?: string;
  relaySessionId?: string;
  readonly relayAttached: boolean;
  summary?: string;
  currentModel?: string;
  pid?: number;

  // ── lifecycle ──
  toJSON(): SessionRecord;
  /** "restart": tear the process down but keep the relay card and the window
   *  record — the session comes straight back under the SAME id. */
  end(reason: "killed" | "process_exited" | "restart"): boolean;
  awaitArchive(): Promise<boolean>;
  forceKill(): boolean;
  /** After an intentional kill: is a termination marker durably on disk (the
   *  window record deleted or tombstoned)? false = only this process's memory
   *  hides the record, so the kill must NOT be reported as done (#567). */
  recordTerminated?(): boolean;
  attachRelay(rs: RelaySession, allowEnded?: boolean): boolean;
  beginWatching(): void;

  // ── app-facing intake / queue ──
  busy(): boolean;
  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean; id?: string }): QueuedMessage;
  /** Restart support: pluck every prompt that has NOT been dispatched yet so
   *  the replacement can take them (same ids — the relay lane tracks them).
   *  Adapters without a pluckable queue leave this undefined. */
  takeQueuedForRestart?(): Array<{ id: string; text: string; source: DeliverySource; mirrorToRelay: boolean; seq?: number; visible: boolean }>;
  /** Restart support: resolve once the process end() signalled is really
   *  gone (kill -9 after `ms`). Adapters whose replacement reopens the same
   *  on-disk conversation implement this so two writers never overlap. */
  awaitExit?(ms?: number): Promise<void>;
  queueState(): QueueState;
  /** Delivery state of ONE queued item, when the adapter can track it (claude).
   *  Callers that need proof a SPECIFIC prompt landed must prefer this over the
   *  session-wide busy() flag; adapters without it return nothing and the caller
   *  falls back. */
  queueItemState?(id: string): QueueItemState;
  resumeQueue(): void;
  editQueued(id: string, text: string): boolean;
  cancelQueued(id: string): boolean;
  reorderQueued(id: string, toIndex: number): boolean;
  abort(): Promise<{ ok: boolean; error?: string }>;

  // ── pane / control surface (tmux window shared by both agents) ──
  detectPermissionMode(): string | null;
  setPermissionMode(target: string): Promise<{ ok: boolean; mode?: string; error?: string }>;
  sendRawKeys(script: string, opts?: { literal?: boolean }): Promise<{ ok: boolean; segments: number; error?: string }>;
  pane(color?: boolean): Promise<{ ok: true; text: string }>;
  resize(cols: number, rows: number): Promise<{ ok: boolean }>;
  transcript(): { lines: unknown[] };

  // ── claude-hook surface (no-op for agents without Claude Code hooks) ──
  onHookEvent(ev: Record<string, unknown>): { ok: boolean };
  markCompacting(trigger: string): void;

  /** Stamp the session card's metadata with this session's v2 linkage
   *  ({sessionId, relay, keyEnvelope}) so the app can route writes over the
   *  v2 plane and unseal content. Optional: adapters merge best-effort. */
  setV2Link?(link: { sessionId: string; relay: string; keyEnvelope: string }): void;

  /** Snapshot of the session's card metadata (the object the app renders in
   *  its list). Used by the nucleus lane to publish the v2 card at bind. */
  cardMetadata?(): Record<string, unknown> | null;
  /** Handoff bar on the card (domain/handoff.ts). Optional: adapters that
   *  cannot show it simply don't implement it. */
  setHandoff?(info: import("../relay/relay").JoyHandoffInfo | null): void;
  /** Tool-call approvals the harness is holding for a human (codex). */
  listApprovals?(): Array<{ requestId: string; kind: string; title: string; detail?: string; since: number }>;
  /** The harness reported it is waiting on a human (claude: PermissionRequest /
   *  Notification hooks) without a first-class approval object to answer. */
  needsInput?(): { kind: string; tool?: string; since: number } | null;
  answerApproval?(params: Record<string, unknown> | undefined): { ok: boolean };
}
