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
import type { SessionStatus, SessionRecord, QueuedMessage, QueueState } from "../claude/session";

export interface AgentSession {
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
  end(reason: "killed" | "process_exited"): boolean;
  awaitArchive(): Promise<boolean>;
  forceKill(): boolean;
  reassertLifecycle(): void;
  attachRelay(rs: RelaySession, allowEnded?: boolean): boolean;
  beginWatching(): void;

  // ── app-facing intake / queue ──
  busy(): boolean;
  enqueue(text: string, opts?: { source?: DeliverySource; mirrorToRelay?: boolean; seq?: number; visible?: boolean; requireDurable?: boolean }): QueuedMessage;
  queueState(): QueueState;
  resumeQueue(): void;
  editQueued(id: string, text: string): boolean;
  cancelQueued(id: string): boolean;
  reorderQueued(id: string, toIndex: number): boolean;
  abort(): Promise<{ ok: true }>;

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
}
