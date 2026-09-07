// The daemon's v2 nucleus lane: the client side of the relay's durable queue
// and the daemon's ONLY app-facing message plane. It acquires a machine
// lease, long-polls the work and control lanes, and bridges claimed v2 turns
// onto the SAME session machinery every other transport uses:
//
//   spawn_session offer → registry.create() → bind (spawnCommandId)
//   prompt offer        → coordinator.accept(relayTurnId) → wait(running) →
//                          /start → output facts → wait(terminal) → terminal
//                          (the command's state IS the turn's outcome)
//   cancel offer        → coordinator.cancel(command) → the interrupt is
//                          retried until confirmed → terminal(cancelled)
//
// Each message travels exactly one lane (the one it was posted on), so a
// prompt is never delivered twice.
//
// Content rides as the v2 test-mode envelope ({v:1,t:'plain',text} /
// {v:1,t:'spawn',...}) — the same seam the app's Relay v2 Mode uses; real
// sealing replaces encode/decode in both places together.
//
// Fail-soft by design: against an unreachable relay (or with the lane
// disabled) the acquire loop logs once and retries quietly — local sessions
// keep running; only app reachability waits.

import { randomUUID, randomBytes } from "node:crypto";
import { hostname } from "node:os";
import tweetnacl from "tweetnacl";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { registerV2CardPublisher, unregisterV2CardPublisher, registerV2SessionId, cardStateFor, publishV2Card } from "./v2Card";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../domain/registry";
import type { AgentSession } from "../domain/agentSession";
import { joyRelayAccessKey, canonicalCwd } from "../paths";
import { setRecordSink, setOutboundPersistDegraded, relaySessionFor, type WireRecord } from "./relay";
import { OutboxSender, type PostResult } from "./outbox";
import { ledgerFor, LedgerWriteError, isTerminalState, TERMINAL_STATES, type JobRow, type NewOutbound, type OutboxRow, type CommandRow, type CommandState } from "../domain/ledger";
import { coordinatorFor } from "../domain/coordinator";
import { writeAttachmentToCwd } from "../domain/attachments";
import { queueFor, isTerminal } from "../domain/queueFacade";
import { cloneForSpawn } from "../domain/operations";
import { deriveSpawnSpecKey } from "../tunnel/sealedStream";

const RENEW_MS = 8_000;           // lease TTL is 20s server-side
const CLAIM_WAIT_MS = 25_000;
const TURN_CAP_MS = 30 * 60_000;  // hard stop: a turn stuck past this is interrupted
const ACQUIRE_RETRY_MS = 60_000;

export interface NucleusLaneOpts {
  registry: SessionRegistry;
  relayUrl: string;
  token: string;      // account bearer (from access.key)
  machineId: string;  // same machine identity the app's machine list shows
  /** Account content PUBLIC key (dataKey pairing). Set → v2 content is
   *  sealed: a per-session symmetric key is generated at spawn, enveloped to
   *  this key (ephemeral NaCl box) in the bind, and every prompt/output
   *  ciphertext is secretbox'd under it. Absent → plaintext test envelopes. */
  accountContentPublicKey?: Uint8Array | null;
  /** The per-machine key (access.key `machineKey`, the tunnel's root). Set →
   *  the lane derives the spawn-spec key (deriveSpawnSpecKey) and opens
   *  sealed `v2e1:` spawn specs, and the handle reports `spawnSpecSealed()`
   *  true so the machine metadata advertises `capabilities.spawnSpecSealed`
   *  and the app seals (#107). Absent → only plain-JSON specs are usable; a
   *  sealed one fails the spawn — so the capability must NOT be advertised
   *  (RelayClient.setSpawnSpecSealed is fed from this handle, never assumed). */
  machineKey?: Uint8Array | null;
  log?: (line: string) => void;
  /** Bounds of the backoff between retries of an owed replacement-row
   *  archive (#120): 2s…60s by default. A test seam — tests inject a short
   *  schedule instead of waiting on the production timers (#623). */
  archiveRetryMs?: { min: number; max: number };
  /** Backoff schedule (ms between attempts) of the in-loop adoption retry
   *  when the relay cannot answer reconcile{running} (5xx, transport): 1s,
   *  2s, 4s, 8s by default, after which the turn is `adoption_pending` and
   *  retried on the slow cadence. A test seam, like `archiveRetryMs`. */
  adoptionRetryMs?: readonly number[];
  /** Cadence (ms) of the slow adoption retry once a turn is parked
   *  `adoption_pending`: 30s by default. A test seam, like `adoptionRetryMs`. */
  adoptionPendingRetryMs?: number;
}

/** One relay turn this lane is driving, as the handle reports it. `state`
 *  `adoption_pending`: the runtime is confirmed running here and the relay
 *  could not be reached to adopt the turn under this lease (an unavailable
 *  answer is unresolved, never a cancel) — the loop keeps retrying while
 *  the command runs; `since`/`attempts`/`lastError` describe that wait. */
export interface RelayTurnState {
  turnId: string; localSessionId: string; commandId: string | null;
  state: "dispatching" | "running" | "adoption_pending";
  since?: number; attempts?: number; lastError?: string;
}

export interface NucleusLaneHandle {
  stop(): Promise<void>;
  /** The relay turns with a live loop here and their recovery state. */
  relayTurns(): RelayTurnState[];
  currentLease(): { leaseId: string; leaseToken: string } | null;
  /** Whether THIS lane can open sealed `v2e1:` spawn specs — i.e. it holds
   *  the machine key. The authoritative source for the machine record's
   *  `capabilities.spawnSpecSealed` advertisement (#107). */
  spawnSpecSealed(): boolean;
  /** Sessions whose relay event budget is exhausted, and how many records
   *  have been dropped since (#130). The same numbers the card banner shows,
   *  readable without one. */
  eventBudgetDrops(): Array<{ v2SessionId: string; localSessionId: string; since: number; dropped: number }>;
}

interface Lease { leaseId: string; leaseToken: string; epoch: string }

interface WorkOffer {
  deliveryId: string; commandId: string; sessionId: string;
  kind: "spawn_session" | "prompt";
  turnId?: string; ciphertext?: string | null;
  attachments?: Array<{ id: string; size: number }>;
  createDir?: boolean;
}
interface ControlOffer { deliveryId: string; commandId: string; sessionId: string; targetTurnId: string }

// ── content codec (the encryption seam — mirrors app sync/v2/api.ts) ───────
// Sealed wire format: "v2e1:" + b64(nonce24 ‖ secretbox(utf8(json), nonce, key)).
// Legacy/test format: plain JSON {v:1,t:'plain',text}, accepted ONLY when the
// session has no key (legacy pairing, no account content key). A session that
// HAS a key gets nothing but authenticated v2e1 envelopes: a relay that swapped
// the ciphertext for ordinary JSON used to have its text accepted unverified
// and dispatched into an otherwise sealed agent session (#579). encode seals
// whenever a key exists.
/** Open one envelope to its JSON payload under this policy; null = refused. */
function openEnvelope(ciphertext: string, key?: Uint8Array | null): any | null {
  if (ciphertext.startsWith("v2e1:")) {
    if (!key) return null; // sealed content without the session key — refuse
    return openSealedJson(ciphertext, key);
  }
  if (key) return null; // plaintext offered to a SEALED session: unauthenticated — refuse (#579)
  try { return JSON.parse(ciphertext); } catch { return null; }
}
/** The `v2e1:` envelope alone: b64(nonce24 ‖ secretbox(utf8(json))) under
 *  `key` → the JSON payload; null on a wrong key, tampering, or bad bytes. */
function openSealedJson(ciphertext: string, key: Uint8Array): any | null {
  try {
    const raw = Buffer.from(ciphertext.slice(5), "base64");
    const n = tweetnacl.secretbox.nonceLength;
    const pt = tweetnacl.secretbox.open(new Uint8Array(raw.subarray(n)), new Uint8Array(raw.subarray(0, n)), key);
    if (!pt) return null;
    return JSON.parse(Buffer.from(pt).toString("utf8"));
  } catch { return null; }
}
/** Why a prompt was refused, for the turn's terminal fact: the app shows it. */
export type PromptRejectReason = "undecodable_prompt" | "plaintext_on_sealed_session";
export function promptRejectReason(ciphertext: string | null | undefined, key?: Uint8Array | null): PromptRejectReason {
  return key && ciphertext && !ciphertext.startsWith("v2e1:") ? "plaintext_on_sealed_session" : "undecodable_prompt";
}
export function decodeContent(ciphertext: string | null | undefined, key?: Uint8Array | null): string | null {
  if (!ciphertext) return null;
  const p = openEnvelope(ciphertext, key);
  return p && typeof p.text === "string" ? p.text : null;
}
/** An attachment cited inside a sealed prompt (mirrors app V2Attachment).
 *  `id` is the relay attachment id; `name` is the sender's filename. */
export interface PromptAttachment { id: string; name: string; size: number; mime?: string }
export interface DecodedPrompt { text: string; attachments: PromptAttachment[] }

/** decodeContent, plus the attachment citations the app embeds beside the
 *  text (sealed together, so the relay's `attachments` id list is only its
 *  GC/validation view — the names live here). */
export function decodePrompt(ciphertext: string | null | undefined, key?: Uint8Array | null): DecodedPrompt | null {
  if (!ciphertext) return null;
  const p = openEnvelope(ciphertext, key);
  if (!p || typeof p.text !== "string") return null;
  const attachments: PromptAttachment[] = [];
  if (Array.isArray(p.attachments)) {
    for (const a of p.attachments) {
      if (!a || typeof a.id !== "string" || typeof a.name !== "string") continue;
      attachments.push({ id: a.id, name: a.name, size: typeof a.size === "number" ? a.size : 0, ...(typeof a.mime === "string" ? { mime: a.mime } : {}) });
    }
  }
  return { text: p.text, attachments };
}

/** Attachment bytes: nonce24 ‖ secretbox(bytes) under the SESSION key (the
 *  app's sealV2Bytes); raw bytes on a plaintext session. null = tampered,
 *  wrong key, or truncated. */
export function openAttachmentBytes(bytes: Uint8Array, key?: Uint8Array | null): Uint8Array | null {
  if (!key) return bytes;
  const n = tweetnacl.secretbox.nonceLength;
  if (bytes.length < n + tweetnacl.secretbox.overheadLength) return null;
  return tweetnacl.secretbox.open(bytes.subarray(n), bytes.subarray(0, n), key);
}

/** The client's spawn options, carried on the durable command. Mirrors the
 *  option set the v1 `joy-create-session` RPC accepted — the new-session screen
 *  is v2-only now, so anything missing here is an option the user cannot set. */
export interface SpawnSpec {
  cwd?: string;
  agent?: string;
  model?: string;
  effort?: string;
  yolo?: boolean;
  createDir?: boolean;
  continue?: boolean;
  resume_id?: string;
  resumeLimitMb?: number;
  permissionMode?: string;
  fallbackModel?: string;
  forkSession?: boolean;
  extraArgs?: string;
  /** Clone (or reuse) this repository into cwd before launching — the same
   *  contract as the `create` op's gitUrl (#151). */
  gitUrl?: string;
}

/** The spawn spec on the wire is either the sealed `v2e1:` envelope under the
 *  machine's spawn-spec key (app sync/v2/spawnSpec.ts, #107) or — from an app
 *  that predates the seal, or one that holds no key for this machine — the
 *  plain JSON `{v:1,t:'spawn',cwd,…}`. Both are accepted: unlike prompts
 *  (#579) plain is NOT refused when a key exists, because the spec was
 *  never authenticated before and old apps must keep spawning. A sealed
 *  spec is accepted ONLY when it opens under `key` — it is the app's proof
 *  that it holds this machine's key. */
export function isSealedSpawnSpec(ciphertext: string | null | undefined): boolean {
  return !!ciphertext && ciphertext.startsWith("v2e1:");
}
export function decodeSpawnSpec(ciphertext: string | null | undefined, key?: Uint8Array | null): SpawnSpec | null {
  if (!ciphertext) return null;
  let p: any;
  if (isSealedSpawnSpec(ciphertext)) {
    if (!key) return null;
    p = openSealedJson(ciphertext, key);
  } else {
    try { p = JSON.parse(ciphertext); } catch { return null; }
  }
  return p && p.t === "spawn" ? p : null;
}
/** Seal a session CARD (the metadata object the app renders in its list)
 *  with the session content key. Plaintext JSON when the session has no key
 *  (legacy pairing) — same policy as message content. */
export function sealCard(metadata: Record<string, unknown>, key?: Uint8Array | null): string {
  const json = JSON.stringify({ v: 1, t: "card", metadata });
  if (!key) return json;
  const nonce = new Uint8Array(randomBytes(tweetnacl.secretbox.nonceLength));
  const ct = tweetnacl.secretbox(new Uint8Array(Buffer.from(json, "utf8")), nonce, key);
  return "v2e1:" + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
}

export function encodeContent(text: string, key?: Uint8Array | null): string {
  const json = JSON.stringify({ v: 1, t: "plain", text });
  if (!key) return json;
  const nonce = new Uint8Array(randomBytes(tweetnacl.secretbox.nonceLength));
  const ct = tweetnacl.secretbox(new Uint8Array(Buffer.from(json, "utf8")), nonce, key);
  return "v2e1:" + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
}

/** Seal an adapter record for the event log: {v:1,t:'record',record}
 *  under the same session key as text. The app opens it and hands `record`
 *  (role 'session' | 'user' | 'agent') straight to its normalizer. */
export function encodeRecord(record: WireRecord, key?: Uint8Array | null): string {
  const json = JSON.stringify({ v: 1, t: "record", record });
  if (!key) return json;
  const nonce = new Uint8Array(randomBytes(tweetnacl.secretbox.nonceLength));
  const ct = tweetnacl.secretbox(new Uint8Array(Buffer.from(json, "utf8")), nonce, key);
  return "v2e1:" + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
}

/** Test/driver counterpart of encodeRecord: the record, or null. */
export function decodeRecord(ciphertext: string | null | undefined, key?: Uint8Array | null): WireRecord | null {
  if (!ciphertext) return null;
  const p = openEnvelope(ciphertext, key);
  return p && p.t === "record" && p.record && typeof p.record.role === "string" ? p.record as WireRecord : null;
}

/** Envelope a fresh session key to the account: "v2sk1:" + b64(epk32 ‖ nonce24
 *  ‖ box(sessionKey, nonce, accountPub, ephemeralSecret)). The app opens it
 *  with its content keypair (crypto_box_open_easy). */
export function sealSessionKey(sessionKey: Uint8Array, accountPub: Uint8Array): string {
  const eph = tweetnacl.box.keyPair();
  const nonce = new Uint8Array(randomBytes(tweetnacl.box.nonceLength));
  const ct = tweetnacl.box(sessionKey, nonce, accountPub, eph.secretKey);
  return "v2sk1:" + Buffer.concat([Buffer.from(eph.publicKey), Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
}

export function startNucleusLane(opts: NucleusLaneOpts): NucleusLaneHandle {
  const { registry, relayUrl, token, machineId } = opts;
  const log = (line: string) => opts.log?.(`[v2-lane] ${line}`);
  // Derived once: the leaf the app seals spawn specs under (#107). Never
  // sent anywhere — both ends compute it from the machine key they share.
  const spawnSpecKey = opts.machineKey ? deriveSpawnSpecKey(opts.machineKey, machineId) : null;
  let stopped = false;
  let lease: Lease | null = null;
  // Chat-log ids are an in-memory counter reset on every boot — a bare
  // chat:<id> runtimeEventId from THIS boot could replay-collide with one
  // from the last boot and get silently dropped by the relay. Scope them.
  const bootNonce = randomUUID().slice(0, 8);
  // The durable acceptance ledger: the outbox (below), and the spawn intents —
  // spawnCommandId → localSessionId, persisted across the create→bind gap so
  // a crash between the two never spawns a SECOND real agent for the same
  // command (the re-offer finds the intent row and only re-binds). One row
  // per command, committed on its own (#75): no whole-map rewrite to truncate.
  const ledger = ledgerFor();
  /** Receipt kinds (keyed on the relay turn id) recording the remote /start
   *  intent and its acknowledgement separately — see postStart. */
  const START_INTENT_RECEIPT = "relay_start_intent";
  const START_ACK_RECEIPT = "relay_start";
  const readSpawnIntent = (commandId: string): string | undefined => ledger.lookupSpawnIntent(commandId) ?? undefined;
  const writeSpawnIntent = (commandId: string, localId: string): void => { ledger.spawnIntent(commandId, localId); };
  // v2 sessionId → local session id, rebuilt from the relay on start and
  // extended by every bind we perform.
  const bound = new Map<string, string>();
  // v2 sessionId → content key. Generated at spawn, persisted in the window
  // record, reloaded on restart. Absent entry = plaintext (legacy) session.
  const sessionKeys = new Map<string, Uint8Array>();
  const coordinator = coordinatorFor(ledger);
  // turnIds with a live loop here (guards the received→submitted re-offer
  // window and the boot resume pass).
  const inFlight = new Set<string>();
  // Executing turns → the local session + the command that carries them:
  // output rows are tagged with their turn.
  // `adoptionPending`: the relay could not answer the adoption of a resumed
  // turn (unavailable, not refused) — the loop keeps the runtime running and
  // retries; the sweep may adopt it meanwhile and clear the marker.
  type AdoptionPending = { since: number; attempts: number; lastError: string };
  const activeTurns = new Map<string, { localId: string; commandId: string | null; lease: Lease; started: boolean; adoptionPending?: AdoptionPending | null }>();
  const ADOPTION_RETRY_MS: readonly number[] = opts.adoptionRetryMs ?? [1_000, 2_000, 4_000, 8_000];
  const ADOPTION_PENDING_RETRY_MS = opts.adoptionPendingRetryMs ?? 30_000;
  // Turns whose attachments are still being materialized: the one window
  // before the command row exists, so a cancel there aborts the preparation.
  const preparing = new Map<string, () => void>();
  // local session id → v2 session id (the inverse of `bound`), for the
  // record sink, which only knows the local id.
  const boundByLocal = new Map<string, string>();

  // Turns we can't run (no local session / undecodable) — logged once, not
  // per re-offer, so a stranded turn doesn't spam the journal every claim.
  const notedSkips = new Set<string>();
  // Turns we looked at and could not run yet (no local runtime): re-check
  // them after a bounded delay rather than on every claim — and never NEVER
  // (a permanent blacklist would strand a prompt whose session comes back;
  // Astra's review of #114).
  const skipUntil = new Map<string, number>();
  const SKIP_RECHECK_MS = 15_000;
  // spawn commandIds abandoned for good (e.g. directory missing and the
  // caller did not opt into creation) — never re-attempted, so the lane does
  // not hot-loop a permanently-failing spawn.
  const abandonedSpawns = new Set<string>();
  // local id → relay row the record still names but the relay no longer has
  // (#120). The app's delete flow is kill-then-DELETE; when the kill never
  // reached the daemon (offline, tunnel 503) the agent kept running and its
  // window record kept the deleted v2SessionId. On reconnect the lane
  // re-bound to that dead row and every card PATCH / facts POST 404'd — an
  // invisible, unkillable agent, across restarts. A row proven gone is
  // remembered here so the recovered-record path does not re-bind to it,
  // and the session is announced again under a fresh row.
  const deadRows = new Map<string, string>();

  const baseHeaders = (): Record<string, string> => {
    const h: Record<string, string> = {};
    const key = joyRelayAccessKey();
    if (key) h["x-joy-relay-key"] = key;
    return h;
  };

  /** asLease: the lease GENERATION captured when the offer was claimed —
   *  lifecycle writes must never silently switch to a newer lease (or to
   *  bearer auth) mid-turn; a stale generation gets the relay's 412 and the
   *  turn resolves through orphaning, deterministically. */
  async function api(method: string, path: string, body?: unknown, asLease?: Lease | null): Promise<any> {
    if (asLease === null) throw new Error("lease_lost");
    const res = await fetch(`${relayUrl}/joy/v2${path}`, {
      method,
      headers: {
        ...baseHeaders(),
        ...(asLease
          ? { "x-joy-lease-id": asLease.leaseId, "x-joy-lease-token": asLease.leaseToken, "x-joy-lease-epoch": asLease.epoch }
          : { Authorization: `Bearer ${token}` }),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000), // a hung relay must not hold a lane loop forever
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${json?.error ?? ""}`);
      (err as Error & { status?: number; relayError?: string }).status = res.status;
      (err as Error & { status?: number; relayError?: string }).relayError = typeof json?.error === "string" ? json.error : undefined;
      throw err;
    }
    return json;
  }

  // ── adapter record forwarding (the chat's tool cards / thinking / usage) ──
  // RelaySession.send lands every adapter record here. Each becomes a sealed
  // `output` fact: on the RUNNING relay turn for that session when there is
  // one (fenced to that turn's lease), else session-scoped. Every record and
  // every terminal fact is a row in the ledger's OUTBOX — committed before
  // anything else, acked only once the relay has it — and ONE scheduler per
  // session (relay/outbox.ts) sends them in persisted order, retrying by the
  // stable runtimeEventId the relay dedupes. A relay outage or a daemon
  // restart loses no output (#60, #67) and leaves no turn unterminated
  // (#74): the rows are still there and the sender resumes from them.
  const recordFailures = new Set<string>();
  const RETRY_MAX_MS = 30_000;
  // How a failed POST is handled. Lease fencing (401 unknown/expired lease,
  // 412 stale epoch) is TRANSIENT: it says nothing about whether the relay
  // has the record, and the next lease can retry — deleting on it lost
  // acknowledged-by-nobody data (Astra's review of 6ebea947). The relay's
  // per-session event budget (429 session_event_budget_exhausted) never
  // clears by retrying: that is a permanent refusal of THIS record.
  type Fate = "transient" | "permanent" | "budget";
  const fateOf = (e: unknown): Fate => {
    const st = (e as { status?: number })?.status;
    const code = (e as { relayError?: string })?.relayError ?? "";
    if (st === 429) return code === "session_event_budget_exhausted" ? "budget" : "transient";
    if (typeof st !== "number") return "transient"; // network, timeout
    if (st === 401 || st === 408 || st === 412 || st >= 500) return "transient";
    return st >= 400 ? "permanent" : "transient";
  };
  const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 300);
  // Sessions whose relay event budget is exhausted: logged once, outputs dropped.
  const budgetExhausted = new Set<string>();
  // …and what that costs, per session (#130). The drop used to be a single
  // daemon log line: the user saw the conversation simply stop growing, with
  // no way to tell a quiet agent from a truncated one. The count rides the
  // card as `joy__eventBudget`, which the app renders like the retry and
  // compacting banners, and it names the only recovery the relay allows — a
  // fresh session (the budget is per session and retrying never clears it,
  // see docs/API.md). Card PATCHes are coalesced: a burst of dropped records
  // is one card PATCH, not one per record — the timer coalesces the NETWORK
  // publication only, never the evidence.
  // `cardDropped` is the count the relay's card is KNOWN to carry (set after
  // a PATCH the relay accepted): the boot repair below re-publishes only
  // cards whose count is behind, not every archived card on every boot.
  type BudgetState = { localId: string; since: number; dropped: number; cardDropped: number };
  const budgetDropped = new Map<string, BudgetState>();
  const budgetPublish = new Map<string, ReturnType<typeof setTimeout>>();
  const BUDGET_PUBLISH_MS = 1_000;
  // The loss OUTLIVES this lane (#130 follow-up), and the LEDGER is its
  // authority: the count used to live only in these maps and on the card
  // holder, and since a full session is exactly the one whose further output
  // never arrives (the relay refuses it), nothing ever re-counted the sole
  // warning after a restart. Persisted as one small job row per session (no
  // schema change; `forgetSession` drops it with the session's record),
  // written INSIDE the outbox transaction that settles the refused row (the
  // `settle` hook on the permanent verdict): a count that reached the ledger
  // only from the one-second publish timer left a window — the row dropped,
  // its checkpoint advanced, the process gone — in which an unclean exit
  // erased the only evidence of the loss (Astra on ccd08aca). The maps are a
  // cache of that row, refilled from it on demand.
  const EVENT_BUDGET_JOB_KIND = "event_budget";
  const budgetJobId = (v2: string) => `event_budget:${v2}`;
  /** The persisted count, or null. Throws when the ledger cannot be read —
   *  inside a settling transaction that must roll the settlement back. */
  function readPersistedBudget(v2: string): BudgetState | null {
    const job: JobRow | null = ledger.getJob(budgetJobId(v2));
    const p = job?.payload as { localId?: unknown; since?: unknown; dropped?: unknown; cardDropped?: unknown } | null | undefined;
    if (!p || typeof p.localId !== "string" || typeof p.since !== "number" || typeof p.dropped !== "number" || p.dropped <= 0) return null;
    return { localId: p.localId, since: p.since, dropped: p.dropped, cardDropped: typeof p.cardDropped === "number" ? p.cardDropped : 0 };
  }
  /** A budget the ledger could not READ is not an absent budget. The count
   *  may well be there (a full session is exactly the one with nothing else
   *  left to say), so a card sealed without it would erase the only warning
   *  — every card path treats this as an unknown outcome and defers the
   *  publication until the read succeeds (Astra on a6443ea8). Noted once per
   *  session; the sweep probes the read and republishes on recovery. */
  class BudgetUnreadableError extends Error {
    constructor(readonly v2: string, cause: unknown) { super(`event budget record for ${v2.slice(0, 8)} unreadable: ${errText(cause)}`); }
  }
  const budgetUnreadable = new Map<string, string>(); // v2 → localId, while unreadable
  function noteBudgetUnreadable(localId: string, v2: string, e: unknown): void {
    if (budgetUnreadable.has(v2)) return;
    budgetUnreadable.set(v2, localId);
    log(`${localId}: event budget record unreadable (${errText(e)}) — card publications for ${v2.slice(0, 8)} deferred until the ledger reads again`);
  }
  /** Sweep-tick probe: once a deferred session's record reads again, put its
   *  live card back on the wire (an owed archive's own retry loop carries it). */
  function retryBudgetReads(): void {
    for (const [v2, localId] of [...budgetUnreadable]) {
      try { readPersistedBudget(v2); } catch { continue; }
      budgetUnreadable.delete(v2);
      log(`${localId}: event budget record readable again — republishing the card`);
      const current = registry.get(localId)?.cardMetadata?.();
      if (current) void publishV2Card(localId, current);
    }
  }
  /** The loss on record for a session — memory first, the ledger behind it —
   *  and the permanence it implies: a session with a persisted count keeps
   *  dropping instead of re-asking the relay. Null when nothing was lost. */
  function budgetStateFor(localId: string, v2: string): BudgetState | null {
    let st = budgetDropped.get(v2) ?? null;
    if (!st) {
      try { st = readPersistedBudget(v2); }
      catch (e) { noteBudgetUnreadable(localId, v2, e); throw new BudgetUnreadableError(v2, e); }
    }
    if (budgetUnreadable.delete(v2)) log(`${localId}: event budget record readable again`);
    if (!st || st.dropped <= 0) return null;
    st.localId = localId;
    budgetDropped.set(v2, st);
    budgetExhausted.add(v2);
    return st;
  }
  function schedulePublishBudget(v2: string): void {
    if (budgetPublish.has(v2)) return;
    const t = setTimeout(() => publishBudget(v2), BUDGET_PUBLISH_MS);
    t.unref?.();
    budgetPublish.set(v2, t);
  }
  function publishBudget(v2: string): void {
    const t = budgetPublish.get(v2);
    if (t) { clearTimeout(t); budgetPublish.delete(v2); }
    const st = budgetDropped.get(v2);
    if (!st) return;
    void relaySessionFor(st.localId)?.updateEventBudget({ since: st.since, dropped: st.dropped })
      .catch(() => { /* the card is best effort; the next drop (or any card publication) re-asserts it */ });
  }
  /** The ONE place card metadata passes through on its way to the relay
   *  (every `sealCard` for a bound session goes via `sealSessionCard`): a
   *  live holder's merge, the boot-time archive of a session with a record
   *  but no runtime, an owed archive job — each carries the loss on record,
   *  so the warning never depends on a surviving adapter or on the holder
   *  having been told. A card already carrying an equal-or-newer count is
   *  left alone. Throws BudgetUnreadableError when the record cannot be
   *  read — the caller defers the publication rather than sealing a card
   *  that may drop the warning. */
  function cardWithEventBudget(localId: string, v2: string, card: Record<string, unknown>): Record<string, unknown> {
    const st = budgetStateFor(localId, v2);
    if (!st) return card;
    const cur = card.joy__eventBudget as { dropped?: unknown } | null | undefined;
    if (cur && typeof cur.dropped === "number" && cur.dropped >= st.dropped) return card;
    return { ...card, joy__eventBudget: { since: st.since, dropped: st.dropped } };
  }
  /** The sealed card and the count it carries (`carried`, null when the
   *  session has no loss on record) — the caller hands `carried` to
   *  `markBudgetPublished` once the relay has accepted the PATCH. */
  function sealSessionCard(localId: string, v2: string, card: Record<string, unknown>, key: Uint8Array | null): { encryptedMetadata: string; carried: number | null } {
    const merged = cardWithEventBudget(localId, v2, card);
    const cur = merged.joy__eventBudget as { dropped?: unknown } | null | undefined;
    const carried = budgetDropped.has(v2) && cur && typeof cur.dropped === "number" ? cur.dropped : null;
    return { encryptedMetadata: sealCard(merged, key), carried };
  }
  /** The relay accepted a card carrying `carried` dropped outputs: remember
   *  that on the job row, so the boot repair leaves this card alone until
   *  the count moves again. Best effort — a lost marker costs one redundant
   *  repair PATCH, never the warning. */
  function markBudgetPublished(v2: string, carried: number | null): void {
    if (carried == null) return;
    const st = budgetDropped.get(v2);
    if (st) { if (st.cardDropped >= carried) return; st.cardDropped = carried; }
    try {
      const job = ledger.getJob(budgetJobId(v2));
      const p = job?.payload as Record<string, unknown> | null | undefined;
      if (!job || !p || (typeof p.cardDropped === "number" && p.cardDropped >= carried)) return;
      ledger.putJob({ id: job.id, sessionId: job.sessionId, kind: job.kind, payload: { ...p, cardDropped: carried } });
    } catch { /* see above */ }
  }
  /** The card a relay row carries, opened with the session key (plaintext
   *  for an unkeyed session); null when absent, unopenable or not a card. */
  function openCard(ciphertext: string | null | undefined, key: Uint8Array | null): Record<string, unknown> | null {
    if (!ciphertext) return null;
    const p = openEnvelope(ciphertext, key);
    return p && p.t === "card" && p.metadata && typeof p.metadata === "object" ? (p.metadata as Record<string, unknown>) : null;
  }
  /** Card publisher (re)wired for a bound session: put the loss on record
   *  back on the holder's card too, so its own snapshot carries it (a later
   *  merge of any other key then republishes it). Idempotent — the holder
   *  skips a redundant merge against a card the relay already has. */
  function reassertBudget(localId: string, v2: string): void {
    try { if (!budgetStateFor(localId, v2)) return; }
    catch { return; } // unreadable: noted once; the sweep republishes the card once the record reads again
    publishBudget(v2);
  }
  /** The verdict for a record the budget refuses: permanent, with the count
   *  as its evidence — recorded by the outbox INSIDE the transaction that
   *  drops the row. The count is read from and written to the ledger there
   *  (not incremented in memory) so a rolled-back settlement, retried on the
   *  row's next attempt, counts the record exactly once. */
  function budgetRefused(localId: string, v2: string): PostResult {
    return {
      ok: false, fate: "permanent", error: "session_event_budget_exhausted",
      settle: () => {
        const prev = readPersistedBudget(v2);
        const st: BudgetState = {
          localId, since: prev?.since ?? budgetDropped.get(v2)?.since ?? Date.now(), dropped: (prev?.dropped ?? 0) + 1,
          cardDropped: prev?.cardDropped ?? budgetDropped.get(v2)?.cardDropped ?? 0,
        };
        ledger.putJob({ id: budgetJobId(v2), sessionId: localId, kind: EVENT_BUDGET_JOB_KIND, payload: { v2SessionId: v2, localId, since: st.since, dropped: st.dropped, cardDropped: st.cardDropped } });
        budgetDropped.set(v2, st);
        schedulePublishBudget(v2);
      },
    };
  }
  // Rows the ledger refused to commit (disk full, EIO). Kept in memory and
  // re-committed on every sweep tick; while any is held the adapters'
  // checkpoints are held too (RelaySession.outboundPersistDegraded), so a
  // crash replays them from the transcript instead of skipping them. Bounded:
  // a disk that stays full cannot grow the daemon without limit.
  const unpersisted: NewOutbound[] = [];
  const UNPERSISTED_MAX = 5_000;
  // Sessions whose backlog is over the cap (ledger.outboundPressure) — a
  // backpressure signal that holds adapter checkpoints and new prompt
  // dispatch instead of evicting (an evicted record may already be covered
  // by a checkpoint, so eviction was silent data loss; Astra, dee28922).
  const overPressure = new Set<string>();
  const publishOutboxHealth = () => setOutboundPersistDegraded(unpersisted.length > 0 || overPressure.size > 0);
  const notePressure = (localId: string): boolean => {
    const p = ledger.outboundPressure(localId);
    if (p.over && !overPressure.has(localId)) {
      overPressure.add(localId);
      log(`${localId}: ${p.rows} undelivered outputs (${Math.round(p.bytes / 1024)} KiB) — dispatch paused and checkpoints held until the backlog drains`);
    } else if (!p.over && overPressure.has(localId)) {
      overPressure.delete(localId);
      log(`${localId}: output backlog back under the cap`);
    }
    return p.over;
  };
  // Terminal rows produced under the CURRENT lease post as turn facts; any
  // other (a previous lease's, a previous daemon's) resolves its turn through
  // reconcile with the recorded outcome. Cleared whenever the lease is lost.
  const freshTerminals = new Set<number>();
  // Nothing is sent until the boot pass (refreshBindings) has loaded the
  // bindings and the sessions' content keys: a row committed before that,
  // for a sealed session, must be sealed with the key the pass loads — never
  // sent in the clear because the key was not in memory yet (#582).
  let bootReady = false;
  /** The content key a row was committed under, if it carries one (#582). */
  const rowKey = (row: OutboxRow): Uint8Array | undefined => {
    if (!row.keyB64) return undefined;
    try { return new Uint8Array(Buffer.from(row.keyB64, "base64")); } catch { return undefined; }
  };
  /** The sealing identity for a relay session, as the outbox persists it (#582). */
  const sealFor = (v2SessionId: string): { sealed: boolean; keyB64?: string } => {
    const k = sessionKeys.get(v2SessionId);
    return k ? { sealed: true, keyB64: Buffer.from(k).toString("base64") } : { sealed: false };
  };

  /** Send one output row. The verdict decides the row's fate in the ledger. */
  async function postOutput(row: OutboxRow): Promise<PostResult> {
    let v2 = row.v2SessionId;
    if (!v2) {
      // Committed before the session had a relay row. The binding map may
      // know it by now (a bind this boot, or a previous daemon's); otherwise
      // wait for the bind to wake the line — unless nothing will ever bind
      // it: the session is gone (a probe, a killed-before-bind scratch
      // session) or it has waited a day.
      const known = boundByLocal.get(row.sessionId);
      if (known) { ledger.bindOutbound(row.sessionId, known, sealFor(known)); v2 = known; }
      else if (!registry.get(row.sessionId) || Date.now() - row.createdAt > 24 * 3_600_000) return { ok: false, fate: "permanent", error: "unbound_abandoned" };
      else return { ok: false, fate: "unbound", error: "session not bound yet" };
    }
    if (budgetExhausted.has(v2)) return budgetRefused(row.sessionId, v2);
    const l = lease;
    if (!l) return { ok: false, fate: "transient", error: "lease_lost" };
    // The key the record was committed under rides the row (#582): a session
    // killed and un-recorded before its output drained used to lose its key,
    // and "no key" selected PLAINTEXT — a previously sealed conversation went
    // to the relay in the clear on replay. The live key wins when the session
    // still has one; the row's copy covers a session whose window record is
    // gone; a sealed row with neither is dropped, never downgraded.
    const key = sessionKeys.get(v2) ?? rowKey(row);
    if (!key && row.sealed) {
      log(`record ${row.runtimeEventId} for ${row.sessionId}: sealed session's content key is unavailable — dropped rather than sent in plaintext (#582)`);
      return { ok: false, fate: "permanent", error: "sealed_key_unavailable" };
    }
    const ciphertext = encodeRecord(row.body as WireRecord, key);
    const turn = row.relayTurnId && activeTurns.get(row.relayTurnId);
    try {
      if (turn) {
        try {
          await api("POST", `/daemon/turns/${row.relayTurnId}/facts`, { type: "output", ciphertext, runtimeEventId: row.runtimeEventId }, l);
        } catch (e) {
          if (fateOf(e) !== "permanent") throw e;
          // The turn will not take it (terminal, fenced out): keep the content on the session.
          await api("POST", `/daemon/sessions/${v2}/facts`, { type: "output", ciphertext, runtimeEventId: row.runtimeEventId }, l);
        }
      } else {
        await api("POST", `/daemon/sessions/${v2}/facts`, { type: "output", ciphertext, runtimeEventId: row.runtimeEventId }, l);
      }
      recordFailures.delete(row.sessionId);
      return { ok: true };
    } catch (e) {
      const fate = fateOf(e);
      if (fate === "budget") {
        if (!budgetExhausted.has(v2)) {
          budgetExhausted.add(v2);
          log(`${row.sessionId}: relay event budget exhausted for v2 ${v2.slice(0, 8)} — further output for this session is dropped; the session needs a fresh card`);
          // Once, on a plane the budget does not gate (#130): the session
          // events are refused from here on, so the only way to say so is
          // the card banner below and a push. Silence is what made this a
          // conversation that simply stopped growing.
          try { relaySessionFor(row.sessionId)?.notifyCustom("This session is full", "The agent is still running, but its output can no longer be saved. Continue in a new session."); }
          catch { /* push is best effort */ }
        }
        return budgetRefused(row.sessionId, v2);
      }
      if (fate === "permanent") {
        log(`record ${row.runtimeEventId} for ${row.sessionId} rejected for good: ${errText(e)} — dropped`);
        if (isRowGone(e)) relayRowGone(row.sessionId, v2, "facts POST 404");
        return { ok: false, fate: "permanent", error: errText(e) };
      }
      if (!recordFailures.has(row.sessionId)) {
        recordFailures.add(row.sessionId);
        log(`record forward failed for ${row.sessionId}: ${errText(e)} — retrying with backoff (muted until the next success)`);
      }
      return { ok: false, fate: "transient", error: errText(e) };
    }
  }

  /** Send one terminal row: a turn fact while its turn is still ours under
   *  the current lease; otherwise resolve the turn with the RECORDED outcome
   *  via reconcile (a previous lease's or daemon's terminal). */
  async function postTerminalRow(row: OutboxRow): Promise<PostResult> {
    const l = lease;
    if (!l) return { ok: false, fate: "transient", error: "lease_lost" };
    const turnId = row.relayTurnId ?? "";
    if (!turnId) return { ok: false, fate: "permanent", error: "terminal without a turn id" };
    const body = row.body as { terminalState?: string; meta?: Record<string, unknown> } & Record<string, unknown>;
    if (freshTerminals.has(row.seq)) {
      try {
        await api("POST", `/daemon/turns/${turnId}/facts`, body, l);
        return { ok: true };
      } catch (e) {
        if (fateOf(e) === "permanent") {
          // Already terminal / turn gone: the relay has an answer for this turn.
          log(`terminal for turn ${turnId.slice(0, 8)} rejected (${errText(e)}) — dropped`);
          return { ok: false, fate: "permanent", error: errText(e) };
        }
        return { ok: false, fate: "transient", error: errText(e) };
      }
    }
    try {
      await api("POST", `/daemon/turns/${turnId}/reconcile`, {
        resolution: "terminal", terminalState: body.terminalState ?? "interrupted",
        meta: { ...(body.meta ?? {}), replayed: true },
      }, l);
      return { ok: true };
    } catch (err) {
      const fate = fateOf(err);
      if (fate === "permanent" && (err as { status?: number }).status !== 409) return { ok: false, fate: "permanent", error: errText(err) };
      // 409 turn_not_orphaned: the relay has not orphaned the old epoch's
      // turn yet (≤20s) — the sender's backoff (1s, 2s, 4s…) covers it.
      return { ok: false, fate: "transient", error: errText(err) };
    }
  }

  const sender = new OutboxSender({
    ledger, ready: () => !!lease && bootReady, log,
    post: (row) => (row.kind === "terminal" ? postTerminalRow(row) : postOutput(row)),
    maxBackoffMs: RETRY_MAX_MS,
  });

  /** Commit rows to the outbox. Null = the ledger refused: the rows are
   *  held in memory (degraded) and re-committed on the sweep — or by the
   *  next commit that succeeds, which lands them FIRST (persisted order). */
  function commitOutbound(rows: NewOutbound[]): number[] | null {
    try {
      if (unpersisted.length) {
        const held = unpersisted.splice(0);
        try {
          const seqs = ledger.enqueueOutbound([...held, ...rows]);
          log(`outbox persistence restored — ${held.length} held row(s) committed`);
          for (const sid of new Set(held.map((r) => r.sessionId))) sender.wake(sid);
          publishOutboxHealth();
          return seqs.slice(held.length);
        } catch (e) {
          unpersisted.unshift(...held);
          throw e;
        }
      }
      return ledger.enqueueOutbound(rows);
    } catch (e) {
      if (!(e instanceof LedgerWriteError)) throw e;
      for (const r of rows) {
        if (unpersisted.length >= UNPERSISTED_MAX) { log(`outbox: ${UNPERSISTED_MAX} rows held in memory and the ledger still refuses writes — dropping ${r.runtimeEventId}`); continue; }
        unpersisted.push(r);
      }
      if (unpersisted.length === rows.length) log(`outbox commit failed: ${errText(e)} — holding rows in memory, adapter checkpoints held until the ledger accepts writes`);
      publishOutboxHealth();
      return null;
    }
  }
  /** Re-commit rows held in memory (sweep). */
  function retryUnpersisted(): void {
    if (!unpersisted.length) return;
    const rows = unpersisted.splice(0);
    try {
      ledger.enqueueOutbound(rows);
      log(`outbox persistence restored — ${rows.length} held row(s) committed`);
      for (const r of new Set(rows.map((r) => r.sessionId))) sender.wake(r);
    } catch (e) {
      unpersisted.unshift(...rows);
      if (!(e instanceof LedgerWriteError)) throw e;
    }
    publishOutboxHealth();
  }

  function forwardRecord(localId: string, wire: WireRecord, recLocalId?: string): void {
    // The app's user row IS the relay's turn.queued event; lane-dispatched
    // prompts enqueue with mirrorToRelay:false, and the claude tailer only
    // mirrors what the app did NOT send — so a user record here is a prompt
    // typed at the terminal, which the app has no other way to see.
    const v2SessionId = boundByLocal.get(localId) ?? null;
    const turnEntry = [...activeTurns.entries()].find(([, v]) => v.localId === localId);
    // The adapter's own verdict on the turn (#584): a turn-end record with
    // status failed/cancelled, seen while the relay turn is running. The
    // idle loop that terminalizes the relay turn used to pick `completed`
    // solely because no cancel was requested — a provider error the adapter
    // had already reported as failed was relayed as a success.
    const row: NewOutbound = {
      sessionId: localId, kind: "output", body: wire,
      runtimeEventId: recLocalId ? `rec:${recLocalId}` : `rec:${bootNonce}:${randomUUID()}`,
      relayTurnId: turnEntry?.[0] ?? null, v2SessionId,
      // Bound: persist the key beside the record now (#582). Unbound: a
      // sealing daemon's row must never leave in plaintext — the bind stamps
      // the key (bindOutbound) once the session has a row and a key.
      ...(v2SessionId ? sealFor(v2SessionId) : { sealed: !!opts.accountContentPublicKey }),
    };
    // Durable before anything else — adapters checkpoint on return. When the
    // ledger refuses, say so: RelaySession.outboundPersistDegraded holds the
    // transcript checkpoint until it accepts writes again.
    if (!commitOutbound([row])) return;
    if (notePressure(localId)) publishOutboxHealth();
    if (v2SessionId) sender.wake(localId); // unbound: flushUnbound wakes the line when the card exists
  }
  /** Records committed before a session was bound: give them their relay id
   *  (and sealing identity) and wake the line now that a card exists. */
  function flushUnbound(localId: string, v2SessionId: string): void {
    const n = ledger.bindOutbound(localId, v2SessionId, sealFor(v2SessionId));
    if (n) log(`${localId}: sending ${n} record(s) committed before bind`);
    sender.wake(localId);
  }
  setRecordSink(forwardRecord);

  /** A turn terminal, durable until acked. The outcome is COMMITTED first —
   *  its outbox seq puts it after every earlier output of that session — and
   *  posted by the session's sender with the current lease: as a turn fact
   *  while the turn is ours, via reconcile (with the recorded outcome) after
   *  a lease change or a restart. Waits a bounded minute for the ack so the
   *  caller's turn context is still live for the fast path; the row keeps
   *  being retried in the background either way. */
  async function postTerminal(turnId: string, localId: string, body: Record<string, unknown>, _leaseRef: Lease): Promise<void> {
    const row: NewOutbound = {
      sessionId: localId, kind: "terminal", runtimeEventId: `term:${turnId}`, relayTurnId: turnId,
      v2SessionId: boundByLocal.get(localId) ?? null, sealed: false, body,
    };
    const seqs = commitOutbound([row]);
    if (!seqs) return; // held in memory; the sweep commits it and reconciles the turn with this outcome
    freshTerminals.add(seqs[0]);
    sender.wake(localId);
    const settled = await sender.awaitSettled(seqs[0], 60_000);
    // Past the minute the sender keeps posting it as a turn fact under this
    // lease (the old background worker's contract); a lease change moves it
    // to reconcile with the recorded outcome. Settled rows leave the set.
    if (settled) freshTerminals.delete(seqs[0]);
    else log(`terminal for turn ${turnId.slice(0, 8)} still unacked after 60s — retrying in the background`);
  }

  /** POST /start for a relay turn with a durable, separately recorded intent
   *  and acknowledgement (Astra on edd69fd1): the intent receipt is committed
   *  BEFORE the request, the ack receipt AFTER the relay answered, both keyed
   *  on the turn; the event id is the stable `start:<turn>`, so a retry after
   *  a crash between the two is ONE event to the relay (a turn already
   *  running answers `replay`). Boot reconciles from the ack alone: a running
   *  row with no ack is posted (again); one with an ack never is. */
  async function postStart(turnId: string, localId: string, commandId: string | null, leaseRef: Lease): Promise<void> {
    if (ledger.hasReceipt(localId, START_ACK_RECEIPT, turnId)) return;
    try { ledger.addReceipt(localId, { kind: START_INTENT_RECEIPT, ref: turnId, commandId }); }
    catch (e) { log(`turn ${turnId.slice(0, 8)}: could not record the /start intent (${errText(e)}) — posting anyway; a boot re-posts under the same event id`); }
    await api("POST", `/daemon/turns/${turnId}/start`, { runtimeEventId: `start:${turnId}` }, leaseRef);
    try { ledger.addReceipt(localId, { kind: START_ACK_RECEIPT, ref: turnId, commandId }); }
    catch (e) { log(`turn ${turnId.slice(0, 8)}: /start acknowledged but the ack could not be recorded (${errText(e)}) — a boot re-posts under the same event id`); }
  }
  /** Was this turn's /start acknowledged by the relay (the durable fact a boot trusts)? */
  const startAcked = (localId: string, turnId: string): boolean => ledger.hasReceipt(localId, START_ACK_RECEIPT, turnId);

  /** ADOPT a relay turn under this lease (reconcile `running`). A turn a
   *  previous daemon generation left dispatching/running on the relay — or
   *  that the sweep already orphaned — whose command the ledger still
   *  carries and whose runtime the new driver generation has confirmed
   *  running is re-fenced to the current epoch instead of being
   *  terminalized as interrupted while the agent keeps working (Astra, C9).
   *  The relay preserves the cancellation state (`cancelling`), answers a
   *  replay for a turn already ours, and its terminal for one it has
   *  already closed. `none` = nothing to adopt: not a predecessor's turn
   *  (409 turn_not_orphaned), or a relay without the resolution.
   *  `refused` = an AUTHORITATIVE no from the relay (a cancel-class 409: the
   *  session is closed, the budget failed the turn) — the one answer that
   *  may stop the prompt. `unavailable` = the relay did not answer (5xx,
   *  timeout, transport): UNRESOLVED, nothing about the turn is known — the
   *  caller retries; it never cancels a runtime-confirmed command and never
   *  falls through to a /start whose refusal would (Astra, F14: a 503 on
   *  reconcile{running} twice cancelled a working agent). Lease death is
   *  rethrown — nothing under this lease can resolve anything any more. */
  type Adoption =
    | { kind: "running" } | { kind: "cancelling" } | { kind: "terminal"; terminalState: string }
    | { kind: "none"; detail?: string } | { kind: "refused"; code: string } | { kind: "unavailable"; detail: string };
  async function adoptRelayTurn(turnId: string, leaseRef: Lease, reason: string): Promise<Adoption> {
    let r: { state?: string; terminalState?: string } | null;
    try {
      r = await api("POST", `/daemon/turns/${turnId}/reconcile`, { resolution: "running", runtimeEventId: `start:${turnId}`, meta: { reason } }, leaseRef);
    } catch (e) {
      const x = e as { status?: number; relayError?: string };
      if (x.status === 409 && (x.relayError === "turn_not_orphaned" || x.relayError === "another_turn_active")) return { kind: "none", detail: x.relayError };
      if (x.status === 409 && x.relayError && START_CANCEL_CLASS.has(x.relayError)) return { kind: "refused", code: x.relayError };
      if (isLeaseDeath(e)) throw e;
      if (fateOf(e) === "transient") return { kind: "unavailable", detail: errText(e) };
      throw e;
    }
    if (r?.state === "terminal") return { kind: "terminal", terminalState: String(r.terminalState ?? "interrupted") };
    if (r?.state === "cancelling") return { kind: "cancelling" };
    if (r?.state === "running") return { kind: "running" };
    return { kind: "none", detail: r?.state };
  }
  /** adoptRelayTurn with a bounded backoff over `unavailable` answers: the
   *  schedule is ADOPTION_RETRY_MS; past it the last unavailable answer is
   *  returned and the caller parks the turn `adoption_pending` (the runtime
   *  keeps running, the slow retry takes over). Every other answer returns
   *  at once. */
  async function adoptWithBackoff(turnId: string, leaseRef: Lease, reason: string, tag: string): Promise<Adoption> {
    let a = await adoptRelayTurn(turnId, leaseRef, reason);
    for (let i = 0; a.kind === "unavailable" && i < ADOPTION_RETRY_MS.length && !stopped; i++) {
      log(`${tag}: adoption unavailable (${a.detail}) — retrying in ${ADOPTION_RETRY_MS[i]}ms (${i + 1}/${ADOPTION_RETRY_MS.length})`);
      await sleep(ADOPTION_RETRY_MS[i]);
      a = await adoptRelayTurn(turnId, leaseRef, reason);
    }
    return a;
  }
  /** Record (or extend) a turn's `adoption_pending` wait on its loop entry. */
  function noteAdoptionPending(turnId: string, detail: string): void {
    const t = activeTurns.get(turnId);
    if (!t) return;
    const prev = t.adoptionPending;
    t.adoptionPending = { since: prev?.since ?? Date.now(), attempts: (prev?.attempts ?? 0) + 1, lastError: detail };
  }
  /** /start refusals that MEAN "stop the prompt": a cancellation that beat
   *  the control offer here, a session closed under the turn (#614), a
   *  budget the relay failed the turn on (#613). Every other 409 is a
   *  recovery question the relay's reconcile answers — never a cancel. */
  const START_CANCEL_CLASS = new Set(["turn_cancelled", "session_archived", "session_failed", "session_event_budget_exhausted"]);

  /** Raw attachment bytes from the relay store (sealed by the sender). */
  async function fetchAttachment(attachmentId: string): Promise<Uint8Array> {
    const res = await fetch(`${relayUrl}/joy/v2/attachments/${attachmentId}`, {
      headers: { ...baseHeaders(), Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`GET /attachments/${attachmentId.slice(0, 8)} -> ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function acquire(): Promise<void> {
    const r = await api("POST", "/daemon/leases", { machineId, capabilities: { transport: "nucleus-lane" } });
    lease = { leaseId: r.leaseId, leaseToken: r.leaseToken, epoch: String(r.epoch) };
    log(`lease ${r.leaseId.slice(0, 8)} epoch ${r.epoch}`);
  }

  async function refreshBindings(): Promise<void> {
    // The relay knows every v2 session and its bound local id — rebuild the
    // map after a restart so prompt offers can find their local sessions.
    const r = await api("GET", "/sessions");
    for (const s of r.sessions ?? []) {
      if (s.daemonId === machineId && s.localSessionId) { bound.set(s.sessionId, s.localSessionId); boundByLocal.set(s.localSessionId, s.sessionId); }
    }
    // BEFORE any cleanup: every relay turn whose command the ledger already
    // closed gets its terminal row derived from that command (Astra, F14).
    // The resume pass used to do this AFTER the orphan pass below, so a
    // crash between the command's `completed` and its outbox row let the
    // boot publish `interrupted` first — the real outcome then only replayed.
    // Across EVERY session the ledger may hold commands for — live handles,
    // window records, and the relay's own rows for this daemon — not the
    // live handles alone (Astra, F21): a session that exists only as a
    // record now was archived below with its saved `completed` never derived.
    materializeLedgerTerminals(r.sessions ?? []);
    // A record can point at a row that is NOT the one the relay has this
    // local session bound to (fny 47457b0f, 2026-09-04: a spawn that
    // resolved to an already-bound live session rewrote the record with the
    // spawn's own, never-bound row id on every retry). The relay's binding
    // is the truth — realign the record so its key is filed under the row
    // the app actually talks to; the re-envelope below then keeps the app
    // and the daemon on that same key.
    for (const rec of registry.listRecords()) {
      const live = boundByLocal.get(rec.id);
      if (live && rec.v2SessionId && rec.v2SessionId !== live && !bound.has(rec.v2SessionId)) {
        registry.saveRecord(rec.id, { v2SessionId: live });
        log(`record ${rec.id}: v2 ${rec.v2SessionId.slice(0, 8)} is not this session's row — realigned to ${live.slice(0, 8)}`);
      }
    }
    // Content keys ride the window records (same trust domain as transcripts).
    for (const rec of registry.listRecords()) {
      if (rec.v2SessionId && rec.v2SessionKey) {
        try { sessionKeys.set(rec.v2SessionId, new Uint8Array(Buffer.from(rec.v2SessionKey, "base64"))); } catch { /* bad record */ }
      }
    }

    // Re-stamp the session card's v2 link for every bound session. Sessions that
    // bound before a field existed (e.g. localSessionId, which the app needs to
    // address the machine plane) would otherwise stay stale forever, since
    // setV2Link only ran at bind time.
    const records = registry.listRecords();
    for (const s of r.sessions ?? []) {
      if (s.daemonId !== machineId || !s.localSessionId) continue;
      // Archived/ended sessions have no live process but their window record
      // (and its session key) is still on disk — their history must stay
      // readable after a content-key rotation too, so the envelope re-stamp
      // below does not require a live session; the card bits do.
      const sess = registry.get(s.localSessionId);
      const rec = records.find((x) => x.id === s.localSessionId);
      if (!sess && !rec?.v2SessionKey) continue;
      const envelope = rec?.v2SessionKey && opts.accountContentPublicKey
        ? sealSessionKey(new Uint8Array(Buffer.from(rec.v2SessionKey, "base64")), opts.accountContentPublicKey)
        : "v2:plaintext";
      if (sess) {
        sess.setV2Link?.({ sessionId: s.sessionId, relay: relayUrl, keyEnvelope: envelope });
        wireCardPublisher(s.localSessionId, s.sessionId);
      }
      // The app takes the session key from the relay ROW, not the card, so
      // persist the fresh envelope there too. Without the account private
      // key the lane cannot tell whether the stored one is still openable,
      // so it re-stamps every bound session once per boot — idempotent, and
      // the only thing that keeps existing sessions readable after the
      // account content key rotates.
      if (envelope.startsWith("v2sk1:") && lease) {
        try {
          await api("PATCH", `/daemon/sessions/${s.sessionId}`, { sessionKeyEnvelope: envelope }, lease);
        } catch (e) {
          log(`re-envelope ${s.sessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
        }
      }
    }

    await reconcileOrphans(r.sessions ?? []);
    await repairArchivedBudgetCards(r.sessions ?? []);
    await reconcileOrphanedTurns(r.sessions ?? []);
  }

  // A loss on record whose card never got it (#130 residual, Astra on
  // a6443ea8): the exact aftermath of the original defect — a persisted
  // count, a row ALREADY archived with a clean card, no runtime — was never
  // repaired on upgrade. The holder's publisher only exists for a live
  // handle and the orphan sweep only touches live rows, so nothing ever
  // re-published that card. This pass runs with every boot pass and refresh:
  // for every persisted count whose row is settled (not active/starting),
  // unowned, and whose card is behind the count (the `cardDropped` marker on
  // the job row, or the card itself when it can be opened), re-publish the
  // row's own card — other metadata preserved, the count merged, the
  // lifecycle state untouched (COALESCE server-side). Each card is repaired
  // once: the marker written after the accepted PATCH keeps the next boot
  // from patching it again.
  let repairUnreadableNoted = false;
  async function repairArchivedBudgetCards(
    rows: Array<{ sessionId: string; daemonId: string; state: string; localSessionId?: string | null; encryptedMetadata?: string | null }>,
  ): Promise<void> {
    const l = lease;
    if (!l) return;
    let jobs: JobRow[];
    try { jobs = ledger.listJobs(EVENT_BUDGET_JOB_KIND); repairUnreadableNoted = false; }
    catch (e) {
      if (!repairUnreadableNoted) { repairUnreadableNoted = true; log(`repair: event budget records unreadable (${errText(e)}) — archived-card repair deferred to the next refresh`); }
      return;
    }
    const byV2 = new Map(rows.filter((s) => s.daemonId === machineId && s.localSessionId).map((s) => [s.sessionId, s] as const));
    for (const j of jobs) {
      if (stopped) return;
      const p = j.payload as { v2SessionId?: unknown; localId?: unknown; dropped?: unknown; cardDropped?: unknown } | null;
      if (!p || typeof p.v2SessionId !== "string" || typeof p.localId !== "string" || typeof p.dropped !== "number" || p.dropped <= 0) continue;
      if (typeof p.cardDropped === "number" && p.cardDropped >= p.dropped) continue; // the card already says it
      const row = byV2.get(p.v2SessionId);
      if (!row || row.state === "active" || row.state === "starting") continue; // live rows: the holder's publisher / the orphan sweep carry it
      if (pendingArchives.has(row.sessionId)) continue; // the owed archive carries it
      const localId = row.localSessionId!;
      const known = registry.get(localId);
      if (known && !isKilledHandle(known)) continue; // a live handle's own publisher tells the truth
      const key = sessionKeys.get(row.sessionId) ?? null;
      const existing = openCard(row.encryptedMetadata, key);
      const rec = registry.listRecords().find((x) => x.id === localId);
      const base: Record<string, unknown> = existing ?? {
        path: rec?.launchCwd ?? "", host: hostname(), machineId,
        joy__state: "archived", joy__sessionId: localId,
        v2: { sessionId: row.sessionId, relay: relayUrl, localSessionId: localId },
      };
      let sealed: { encryptedMetadata: string; carried: number | null };
      try { sealed = sealSessionCard(localId, row.sessionId, base, key); }
      catch (e) { if (e instanceof BudgetUnreadableError) continue; throw e; } // noted once; the next refresh retries
      if (sealed.carried == null) continue;
      const cur = existing?.joy__eventBudget as { dropped?: unknown } | null | undefined;
      if (cur && typeof cur.dropped === "number" && cur.dropped >= sealed.carried) { markBudgetPublished(row.sessionId, sealed.carried); continue; } // carried already, marker only
      try {
        await withTimeout(api("PATCH", `/daemon/sessions/${row.sessionId}`, { encryptedMetadata: sealed.encryptedMetadata }, l), 15_000);
        markBudgetPublished(row.sessionId, sealed.carried);
        log(`repair: card ${row.sessionId.slice(0, 8)} (local ${localId}, ${row.state}) now carries the ${sealed.carried} dropped output(s) on record`);
      } catch (e) {
        log(`repair: card ${row.sessionId.slice(0, 8)} failed: ${errText(e)} — the next refresh retries`);
      }
    }
  }

  // An ORPHANED TURN wedges its session's queue on the relay, permanently.
  // claimWork refuses to offer a prompt for any session with a turn in
  // dispatching/running/cancelling/orphaned, and the relay's sweep marks a
  // turn orphaned whenever the daemon generation running it dies (a restart
  // mid-turn, a fence violation). Nothing then resolves it — the daemon never
  // called the reconcile route — so every later message is ACCEPTED by the
  // relay (it appears in the chat) and NEVER offered: no dispatch, no local
  // queue, no log line anywhere, and only the tmux pane still reaches the
  // agent. Observed live 2026-09-03: session 1e81457c sat behind an orphaned
  // turn from a killed daemon with SEVEN queued turns behind it.
  //
  // We cannot resume such a turn — the local dispatch state died with the
  // process — so terminalize it as `interrupted`, which is what actually
  // happened, and let the queue behind it flow.
  // Orphaned turns a live local command still owns, logged once each (the
  // sweep re-reads wedged-looking rows every tick).
  const notedOwnedOrphans = new Set<string>();
  async function reconcileOrphanedTurns(
    rows: Array<{ sessionId: string; daemonId: string; localSessionId?: string | null }>,
  ): Promise<void> {
    const l = lease;
    if (!l) return;
    for (const s of rows) {
      if (s.daemonId !== machineId || !s.localSessionId) continue;
      if (!registry.get(s.localSessionId)) {
        // Dead session — reconcileOrphans archives it. Its LEDGER is still
        // consulted (Astra, F21): a turn whose command closed here with no
        // terminal row gets that row derived from the command, so the saved
        // outcome — not the archive, not an invented `interrupted` — is what
        // resolves the orphaned turn. Local and idempotent; no relay read.
        materializeLedgerTerminalsFor(s.localSessionId);
        continue;
      }
      try {
        const st = await api("GET", `/sessions/${s.sessionId}`);
        const ex = st?.execution as { state?: string; turnId?: string } | undefined;
        if (ex?.state !== "orphaned" || !ex.turnId) continue;
        const owner = ledger.commandForRelayTurn(ex.turnId);
        if (owner && isTerminalState(owner.state)) {
          // The ledger already holds this turn's OUTCOME: the command closed
          // and the process died before its terminal row was committed
          // (Astra, F14). The row is derived from the command — under the
          // command's own terminal reason — never invented here: an
          // `interrupted` from this pass would win the relay's first-terminal
          // rule over the real `completed`. materializeLedgerTerminal is
          // idempotent (the stable `term:<turn>` id) and the sender resolves
          // the turn with the recorded outcome via reconcile.
          materializeLedgerTerminal(owner, s.localSessionId);
          sender.wake(s.localSessionId);
          continue;
        }
        if (ledger.hasTerminalFor(ex.turnId)) {
          // We KNOW how this turn ended — the terminal just never landed.
          // The session's sender resolves it with the recorded outcome; a
          // generic "interrupted" here would win the relay's first-terminal rule.
          sender.wake(s.localSessionId);
          continue;
        }
        // A LIVE local command still owns this turn: a previous generation's
        // dispatch, carried in the ledger, whose runtime survived the
        // restart. This pass used to interrupt it on the relay regardless —
        // /start then 409'd and the loop cancelled a working agent on every
        // restart (Astra, C9). The ledger is consulted BEFORE any cleanup:
        // the loop that resumes the row (resumeLedgerTurns, right after the
        // boot pass) adopts the turn under this lease once the driver has
        // confirmed the runtime running; a turn orphaned later, under a loop
        // that already passed that point, is adopted here.
        if (owner) {
          const loop = activeTurns.get(ex.turnId);
          if (loop?.started && (owner.state === "running" || owner.state === "cancelling")) {
            const a = await adoptRelayTurn(ex.turnId, l, "orphan_sweep");
            if (a.kind === "cancelling" && owner.cancelRequestedAt == null) coordinator.cancel(owner.id);
            if (a.kind === "unavailable") {
              // Unresolved, not a verdict: the loop keeps the runtime and
              // retries on its own cadence; this pass never cancels on it.
              noteAdoptionPending(ex.turnId, a.detail);
              log(`reconcile: turn ${ex.turnId.slice(0, 8)} on ${s.sessionId.slice(0, 8)} is orphaned on the relay, ${owner.id} still runs it here and the relay cannot answer its adoption (${a.detail}) — adoption_pending, left running`);
              continue;
            }
            // Any RESOLVED answer — adopted (running/cancelling) or a terminal
            // the relay already holds — ends the pending wait: the loop's
            // next pass reads the marker and returns to a plain bounded wait.
            if ((a.kind === "running" || a.kind === "cancelling" || a.kind === "terminal") && loop.adoptionPending) loop.adoptionPending = null;
            log(`reconcile: turn ${ex.turnId.slice(0, 8)} on ${s.sessionId.slice(0, 8)} was orphaned but ${owner.id} still runs it here → ${a.kind === "none" ? "left to its loop" : a.kind === "refused" ? `refused (${a.code}) — left to its loop` : `adopted (${a.kind})`}`);
            notedOwnedOrphans.delete(ex.turnId);
          } else if (!notedOwnedOrphans.has(ex.turnId)) {
            notedOwnedOrphans.add(ex.turnId);
            log(`reconcile: turn ${ex.turnId.slice(0, 8)} on ${s.sessionId.slice(0, 8)} is orphaned on the relay but ${owner.id} (${owner.state}) still owns it here — left to its loop`);
          }
          continue;
        }
        await api("POST", `/daemon/turns/${ex.turnId}/reconcile`, {
          resolution: "terminal",
          terminalState: "interrupted",
          meta: { reason: "daemon_restart" },
        }, l);
        const queued = (st?.queue as { queuedTurns?: number } | undefined)?.queuedTurns ?? 0;
        log(`reconcile: turn ${ex.turnId.slice(0, 8)} on ${s.sessionId.slice(0, 8)} was orphaned → interrupted (${queued} turn(s) were stuck behind it)`);
      } catch (e) {
        log(`reconcile: turn check on ${s.sessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  // Sessions the relay still lists as live for THIS daemon but that no local
  // runtime backs — the window died while the daemon was down, a tmux
  // kill-server, a wiped record. Nothing else can ever archive them (card
  // writes are fenced to the owner daemon), so left alone they stay
  // active/starting forever and the app shows a session that does not exist.
  // Archive them, with a minimal card from the window record when one
  // survives so the row still reads as "that project, on this machine".
  // Rows with no localSessionId are pre-bind spawns we may yet claim — skip.
  async function reconcileOrphans(rows: Array<{ sessionId: string; daemonId: string; state: string; localSessionId?: string | null }>): Promise<void> {
    const l = lease;
    if (!l) return;
    // Replacement rows whose archive is still owed (#120): the persisted
    // intents go first, on every boot pass and refresh, and keep their own
    // backoff loop between passes.
    const settled = await retryPendingArchives();
    if (pendingArchives.size > 0) scheduleArchiveRetry();
    for (const s of rows) {
      if (s.daemonId !== machineId || !s.localSessionId) continue;
      if (s.state !== "active" && s.state !== "starting") continue;
      if (settled.has(s.sessionId) || pendingArchives.has(s.sessionId)) continue; // just archived above, or owed to the retry loop
      // A live handle is skipped, and so is an ended-but-known one (its own
      // publisher tells the truth). A KILLED handle is different: the
      // registry retains it for bookkeeping only, its card publisher is gone
      // (cardMetadata null) — a row it still owns is as orphaned as one with
      // no handle at all, and skipping it left a replacement row `starting`
      // forever (Astra on 2615f870, #120).
      const known = registry.get(s.localSessionId);
      if (known && !isKilledHandle(known)) continue;
      const rec = registry.listRecords().find((x) => x.id === s.localSessionId);
      const key = sessionKeys.get(s.sessionId) ?? null;
      const card = {
        path: rec?.launchCwd ?? known?.cwd ?? "",
        host: hostname(),
        machineId,
        joy__state: "archived",
        joy__sessionId: s.localSessionId,
        v2: { sessionId: s.sessionId, relay: relayUrl, localSessionId: s.localSessionId },
      };
      // The ledger may still owe this session's LAST WORD (Astra, F21): a
      // command that closed with a relay turn and no terminal row — the
      // process died between the two commits — for a session that is only
      // a record now. The row is derived from the command first
      // (idempotent), and the archive waits until that outcome's delivery
      // is ARRANGED and landed: while a terminal row for the session is
      // still unacked, the archive is owed to the retry loop, which lands it
      // after the saved terminal — never ahead of it, never instead of it.
      materializeLedgerTerminalsFor(s.localSessionId);
      if (owesTerminal(s.localSessionId)) {
        log(`reconcile: archive ${s.sessionId.slice(0, 8)} deferred — local ${s.localSessionId} still owes a saved terminal to the relay; it lands first`);
        deferArchive({ v2SessionId: s.sessionId, localSessionId: s.localSessionId, card, keyB64: key ? Buffer.from(key).toString("base64") : null });
        continue;
      }
      let sealed: { encryptedMetadata: string; carried: number | null };
      try { sealed = sealSessionCard(s.localSessionId, s.sessionId, card, key); }
      catch (e) {
        if (!(e instanceof BudgetUnreadableError)) throw e;
        // The loss on record cannot be read: a clean archive here would
        // erase the only warning. Park the archive as an owed job instead —
        // it retries with backoff until the record reads again.
        log(`reconcile: archive ${s.sessionId.slice(0, 8)} deferred — ${e.message}`);
        deferArchive({ v2SessionId: s.sessionId, localSessionId: s.localSessionId, card, keyB64: key ? Buffer.from(key).toString("base64") : null });
        continue;
      }
      try {
        await api("PATCH", `/daemon/sessions/${s.sessionId}`, { encryptedMetadata: sealed.encryptedMetadata, state: "archived" }, l);
        markBudgetPublished(s.sessionId, sealed.carried);
        log(`reconcile: archived orphan ${s.sessionId.slice(0, 8)} (local ${s.localSessionId} has no runtime)`);
      } catch (e) {
        log(`reconcile: archive ${s.sessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }


  /** A 404 that says the SESSION ROW is gone (deleted card), as opposed to a
   *  turn or delivery that is not receivable. */
  const isRowGone = (e: unknown): boolean => {
    const x = e as { status?: number; relayError?: string } | null;
    return x?.status === 404 && (x.relayError === undefined || x.relayError === "session_not_found");
  };
  /** The relay row a local session was bound to no longer exists (#120):
   *  drop the binding so nothing else is written into the void, remember the
   *  dead row, and — while the agent is still running — announce it again so
   *  the app gets a card it can see, message and kill. */
  function relayRowGone(localId: string, v2SessionId: string, why: string): void {
    if (boundByLocal.get(localId) !== v2SessionId) return; // already moved on
    bound.delete(v2SessionId); boundByLocal.delete(localId);
    unregisterV2CardPublisher(localId);
    deadRows.set(localId, v2SessionId);
    const s = registry.get(localId);
    const live = !!s && (s.status === "active" || s.status === "starting");
    log(`${localId}: relay row ${v2SessionId.slice(0, 8)} is gone (${why}) — unbound${live ? "; re-announcing the live session" : ""}`);
    if (live) void announceLocalSession(s!);
  }

  // Register the v2 card publisher for a bound session: every metadata merge
  // (title, joy__state, model, queue…) re-seals the full card with the session
  // content key and PATCHes the relay. Also fires ONCE immediately so a fresh
  // bind (or a daemon restart's rebind) publishes the current card without
  // waiting for the next change.
  function wireCardPublisher(localId: string, v2SessionId: string): void {
    registerV2SessionId(localId, v2SessionId);
    flushUnbound(localId, v2SessionId);
    registerV2CardPublisher(localId, async (metadata) => {
      const key = sessionKeys.get(v2SessionId) ?? null;
      const l = lease;
      if (!l) throw new Error("lane down"); // rebind republishes
      try {
        // An unreadable budget record throws here: the holder keeps the card
        // dirty and the sweep republishes it once the record reads again.
        const sealed = sealSessionCard(localId, v2SessionId, metadata, key);
        await api("PATCH", `/daemon/sessions/${v2SessionId}`, {
          encryptedMetadata: sealed.encryptedMetadata,
          state: cardStateFor(metadata.joy__state),
        }, l);
        markBudgetPublished(v2SessionId, sealed.carried);
      } catch (e) {
        log(`card publish ${v2SessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
        if (isRowGone(e)) relayRowGone(localId, v2SessionId, "card PATCH 404");
        throw e;
      }
    });
    const current = registry.get(localId)?.cardMetadata?.();
    if (current) void publishV2Card(localId, current);
    reassertBudget(localId, v2SessionId);
  }

  async function claim(lane: "work" | "control", asLease?: Lease | null): Promise<Array<WorkOffer & ControlOffer>> {
    const l = asLease ?? lease;
    if (!l) return [];
    const res = await fetch(`${relayUrl}/joy/v2/daemon/leases/${l.leaseId}/claims/${lane}`, {
      method: "POST",
      headers: { ...baseHeaders(), "x-joy-lease-token": l.leaseToken, "content-type": "application/json" },
      body: JSON.stringify({ waitMs: CLAIM_WAIT_MS }),
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const err = new Error(`claim ${lane} -> ${res.status} ${json?.error ?? ""}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return json?.offers ?? [];
  }

  function localSession(v2SessionId: string): AgentSession | null {
    const localId = bound.get(v2SessionId);
    if (!localId) return null;
    return registry.get(localId) ?? null;
  }

  /** Report a spawn that could not run. `deliveryId` names the ATTEMPT (#612):
   *  a report delayed past a retry that already bound is answered
   *  `{ok:true, applied:false, reason}` and never overwrites the binding —
   *  logged here, not treated as an error (the relay is right to ignore it). */
  /** `applied:false` reasons that mean the COMMAND has moved on — a later
   *  attempt bound it, or the session already left provisioning. There is no
   *  spawn left to fail, so the command is finished with either way. Every
   *  other `applied:false` (`stale_attempt`, `ambiguous_attempt`) retires
   *  only THIS delivery: the command is still live and still needs a report
   *  (#581 residual, Astra on 81386fd0). */
  const SPAWN_COMMAND_SETTLED = new Set(["already_bound", "already_progressed"]);

  /** Returns whether the spawn COMMAND may now be abandoned (#581).
   *
   *  Only a POSITIVE answer abandons it: `applied:true` (the relay applied the
   *  failure to the live attempt) or a settled reason (the command already
   *  moved on). Everything else keeps the command live so the next offer — a
   *  fresh delivery — retries the spawn, hits the same failure, and reports
   *  again. Three ways it must not be abandoned. A report lost to a transient
   *  503 used to leave the command abandoned AND unreported — the relay kept
   *  offering it, the lane answered every offer with a bare receipt, and the
   *  app never saw the directory approval it needed. A report answered
   *  `applied:false, reason:'stale_attempt'` was read as an acknowledgement,
   *  which abandoned the whole command even though the relay had explicitly
   *  NOT applied the failure: same silent dead end, one HTTP round trip
   *  later. And a 200 that says nothing at all — a null body, `{}`, or
   *  `{ok:false}` with no application result — was read the same way
   *  (Astra on e63be78b); that is an UNKNOWN outcome, not an acknowledgement,
   *  so it retires only this delivery. */
  async function reportSpawnFailed(offer: WorkOffer, reason: string, leaseRef: Lease): Promise<boolean> {
    const kind = reason.split(":")[0];
    const who = `spawn ${offer.sessionId.slice(0, 8)}`;
    try {
      const raw = await api("POST", `/daemon/sessions/${offer.sessionId}/spawn-failed`,
        { reason, deliveryId: offer.deliveryId }, leaseRef) as unknown;
      const r = raw && typeof raw === "object" ? raw as { ok?: unknown; applied?: unknown; reason?: unknown } : null;
      const why = typeof r?.reason === "string" ? r.reason : null;
      if (why && SPAWN_COMMAND_SETTLED.has(why)) {
        log(`${who}: ${kind} report settled (${why}) — the command already moved on`);
        return true;
      }
      if (r?.applied === true) return true;
      if (r?.applied === false) {
        log(`${who}: ${kind} report not applied (${why ?? "unknown"}) — delivery ${offer.deliveryId.slice(0, 8)} is not the live attempt; the command is still live — reporting again on its next offer`);
        return false;
      }
      log(`${who}: ${kind} report answered without an application result (${raw == null ? String(raw) : JSON.stringify(raw)}) — outcome unknown, reporting again on its next offer`);
      return false;
    } catch (e2) {
      log(`spawn ${offer.sessionId.slice(0, 8)}: failed to report ${kind}: ${String(e2)} — will retry on the next offer`);
      return false;
    }
  }

  async function handleSpawn(offer: WorkOffer, leaseRef: Lease): Promise<void> {
    await api("POST", `/daemon/deliveries/${offer.deliveryId}/received`, {}, leaseRef);
    // A client retry re-queues the spawn WITH createDir on the offer — clear
    // the abandon mark so we attempt it again. Without createDir it stays
    // abandoned (avoids re-spinning a still-missing directory).
    if (offer.createDir) abandonedSpawns.delete(offer.commandId);
    if (abandonedSpawns.has(offer.commandId)) return;
    const spec = decodeSpawnSpec(offer.ciphertext, spawnSpecKey);
    if (!spec && isSealedSpawnSpec(offer.ciphertext)) {
      // A sealed spec that did not open (#107): the app sealed under a key
      // this daemon does not derive — a stale machine key after a re-pair,
      // or a daemon with no machine key at all. Waiting would only hang the
      // app's create until its deadline; report it, launch nothing.
      const detail = spawnSpecKey
        ? "sealed spawn spec did not open under this machine's key"
        : "sealed spawn spec, but this daemon holds no machine key";
      if (await reportSpawnFailed(offer, `bad_spawn_spec:${detail}`, leaseRef)) abandonedSpawns.add(offer.commandId);
      log(`spawn ${offer.sessionId.slice(0, 8)}: ${detail} — reported bad_spawn_spec, nothing launched`);
      return;
    }
    if (!spec?.cwd) {
      // Undecodable/incomplete spec: leave the command for a human — binding
      // a session we cannot actually run would strand prompts harder.
      log(`spawn ${offer.sessionId.slice(0, 8)}: no usable spawnSpec (need {t:'spawn',cwd,...}) — skipped`);
      return;
    }
    // ONE canonical cwd for the clone, the intent and the launch (#549
    // residual): the clone took the spec's raw `~/repo` and put the checkout
    // under `<daemon cwd>/~/repo`, while create() expanded the same spelling
    // to the home directory — the agent launched in an empty folder. Same
    // contract as the `create` op: canonicalise once, before any step.
    let cwd = canonicalCwd(spec.cwd);
    let localId: string | undefined;
    try {
      // Idempotency across the create→bind gap: a prior attempt that crashed
      // after create left an intent record — re-bind that session instead of
      // spawning a second real agent for the same command.
      const prior = readSpawnIntent(offer.commandId);
      let session = prior ? registry.get(prior) : undefined;
      if (session && session.status === "ended") session = undefined;
      if (session) spawning.add(localId = session.id);
      if (!session && spec.gitUrl) {
        // git-URL spawn: the relay path never cloned — the app's "new session
        // from a repository URL" launched the agent in an empty directory
        // (#151). Same validation + clone as the `create` op, BEFORE any id is
        // reserved: a clone that fails is a spawn failure the app can show,
        // and the agent is never launched.
        const gitUrl = spec.gitUrl.trim();
        // cloneForSpawn validates the URL and throws a user-facing message
        // ("invalid git url", "git clone failed: …") on any failure.
        let cloneError: string | null = null;
        try { cwd = await cloneForSpawn(gitUrl, cwd); } catch (e) { cloneError = e instanceof Error ? e.message : String(e); }
        if (cloneError !== null) {
          if (await reportSpawnFailed(offer, `clone_failed:${cloneError}`, leaseRef)) abandonedSpawns.add(offer.commandId);
          log(`spawn ${offer.sessionId.slice(0, 8)}: clone of ${gitUrl} failed — ${cloneError}`);
          return;
        }
      }
      if (!session) {
        // Choose the local id NOW and persist the intent BEFORE create(): a
        // crash between create and the intent write left the relay's spawn
        // command unmapped, and the retry spawned a second agent for the
        // same request (#75). A crash mid-create leaves a half-made server
        // under this id, which #newAgentServer retires on the retry.
        let chosen = prior ?? randomUUID().replace(/-/g, "").slice(0, 8);
        for (let tries = 0; tries < 8 && registry.get(chosen)?.id === chosen; tries++) chosen = randomUUID().replace(/-/g, "").slice(0, 8); // never reserve a live runtime's id
        writeSpawnIntent(offer.commandId, chosen);
        spawning.add(localId = chosen);
        session = await registry.create({
          id: chosen,
          cwd,
          agent: (spec.agent as AgentSession["agentFlavor"]) ?? "claude",
          model: spec.model,
          effort: spec.effort,
          yolo: spec.yolo ?? true,
          // create-if-missing comes from the client's retry choice (the
          // relay rides it on the offer) or the spawnSpec. Off + missing →
          // report a spawn failure so the client can offer to create + retry.
          createDir: offer.createDir ?? spec.createDir ?? false,
          continue: spec.continue,
          resume_id: spec.resume_id,
          resumeLimitMb: spec.resumeLimitMb,
          permissionMode: spec.permissionMode,
          fallbackModel: spec.fallbackModel,
          forkSession: spec.forkSession,
          extraArgs: spec.extraArgs,
        });
        if (session.id !== chosen) writeSpawnIntent(offer.commandId, session.id); // create() returned an existing session instead
        spawning.add(localId = session.id);
      }
      // Already bound to ANOTHER relay row (an announce raced this spawn, or
      // an earlier daemon generation bound it and this command was re-offered):
      // the relay refuses a second bind for the same local id, so retrying
      // every 5s is a permanent hot loop with the app's spinner on top. Fail
      // this command; the session is reachable through its existing card.
      const elsewhere = boundByLocal.get(session.id);
      if (elsewhere && elsewhere !== offer.sessionId) {
        if (await reportSpawnFailed(offer, `already_bound:${elsewhere}`, leaseRef)) abandonedSpawns.add(offer.commandId);
        log(`spawn ${offer.sessionId.slice(0, 8)}: local ${session.id} is already bound to v2 ${elsewhere.slice(0, 8)} — reported, abandoned`);
        return;
      }
      // Content sealing: with the account's content public key on hand,
      // mint the session's symmetric key, persist it beside the window
      // record, and envelope it to the account in the bind. Without the
      // key (legacy pairing) the session stays on plaintext envelopes.
      // The key and envelope are minted ONCE per (spawn, session) and
      // persisted before the POST: a retry after a lost bind reply must
      // re-send the SAME envelope. A fresh key per attempt left the relay
      // row holding envelope A while the daemon sealed under key B — every
      // message and the card undecryptable for the app (#116).
      let envelope = "v2:plaintext";
      const prevRec = registry.listRecords().find((r) => r.id === session.id);
      if (opts.accountContentPublicKey) {
        let key: Uint8Array;
        if (prevRec?.v2SessionId === offer.sessionId && prevRec.v2SessionKey && prevRec.v2AnnounceEnvelope) {
          key = new Uint8Array(Buffer.from(prevRec.v2SessionKey, "base64"));
          envelope = prevRec.v2AnnounceEnvelope;
        } else {
          key = new Uint8Array(randomBytes(32));
          envelope = sealSessionKey(key, opts.accountContentPublicKey);
          registry.saveRecord(session.id, { v2SessionId: offer.sessionId, v2SessionKey: Buffer.from(key).toString("base64"), v2AnnounceEnvelope: envelope });
        }
        sessionKeys.set(offer.sessionId, key);
      } else {
        registry.saveRecord(session.id, { v2SessionId: offer.sessionId });
      }
      try {
        await api("POST", `/daemon/sessions/${offer.sessionId}/bind`, {
          spawnCommandId: offer.commandId,
          localSessionId: session.id,
          sessionKeyEnvelope: envelope,
        }, leaseRef);
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st === 404 || st === 410) {
          // The relay row is gone — the app timed out and cancelled the spawn
          // after we had already created the agent. Nothing will ever bind or
          // drive it: kill it instead of leaving an orphan running (Astra on
          // 26590d14, #151).
          abandonedSpawns.add(offer.commandId);
          log(`spawn ${offer.sessionId.slice(0, 8)}: relay session gone at bind (${st}) — killing local ${session.id}`);
          try { await session.forceKill(); } catch (e2) { log(`spawn ${offer.sessionId.slice(0, 8)}: kill of orphaned ${session.id} failed: ${String(e2)}`); }
          return;
        }
        throw e;
      }
      bound.set(offer.sessionId, session.id); boundByLocal.set(session.id, offer.sessionId);
      try { ledger.bindSpawnIntent(offer.commandId); } catch { /* informational */ }
      // Stamp the session card with its v2 link so the app can address this
      // session — envelope included so the app needs no extra fetch to obtain
      // the content key.
      session.setV2Link?.({ sessionId: offer.sessionId, relay: relayUrl, keyEnvelope: envelope });
      wireCardPublisher(session.id, offer.sessionId);
      log(`spawned ${spec.agent ?? "claude"} in ${spec.cwd} → local ${session.id} (v2 ${offer.sessionId.slice(0, 8)}${envelope.startsWith("v2sk1:") ? ", sealed" : ", plaintext"})`);
    } catch (e) {
      if (e instanceof DirectoryCreationApprovalRequired) {
        // Report the missing directory to the relay so the client can offer to
        // create it and retry (v1-parity). The relay marks the session failed,
        // which drops it from the work claim — no hot-retry, no app spinner.
        // Abandoned only once the report is acknowledged (#581).
        if (await reportSpawnFailed(offer, `dir_missing:${spec.cwd}`, leaseRef)) abandonedSpawns.add(offer.commandId);
        log(`spawn ${offer.sessionId.slice(0, 8)}: directory does not exist — reported for client retry (${spec.cwd})`);
        return;
      }
      // Other failures (missing binary, transient) — the command stays queued
      // and keeps being offered; back off so we don't hot-loop.
      log(`spawn ${offer.sessionId.slice(0, 8)} FAILED: ${String(e)}`);
      await sleep(5_000);
    } finally {
      if (localId) spawning.delete(localId);
    }
  }

  let lastBindingsRefresh = 0;
  /** 409s that say the SESSION is over, not the turn (#614): archived or
   *  failed while this turn's submit/start was in flight. Cancel-class: the
   *  prompt must not run, nothing is retried, and no `failed` terminal is
   *  posted — the relay already resolved the queue (queued turns cancelled)
   *  and an in-flight turn is closed with a `cancelled` terminal below. */
  const SESSION_GONE = new Set(["session_archived", "session_failed"]);
  const sessionGone = (e: unknown): string | null => {
    const x = e as { status?: number; relayError?: string } | null;
    return x?.status === 409 && x.relayError && SESSION_GONE.has(x.relayError) ? x.relayError : null;
  };

  async function runTurn(offer: WorkOffer, leaseRef: Lease): Promise<void> {
    const turnId = offer.turnId!;
    if (inFlight.has(turnId)) return;
    inFlight.add(turnId);
    let turnLocalId = bound.get(offer.sessionId) ?? ""; // for the catch below, which runs outside the session's scope
    try {
      try {
        await api("POST", `/daemon/deliveries/${offer.deliveryId}/received`, {}, leaseRef);
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st === 404 || st === 409 || st === 412) {
          // The delivery was superseded (the user edited the queued message
          // after we fetched it — #57) or belongs to a dead epoch: the next
          // claim brings a fresh delivery with the current payload.
          log(`turn ${turnId.slice(0, 8)}: delivery ${offer.deliveryId.slice(0, 8)} not receivable (${(e as Error).message}) — left for re-claim`);
          return;
        }
        throw e;
      }
      let session = localSession(offer.sessionId);
      if (!session) {
        // The binding map may be stale (daemon restarted since bind) —
        // self-heal from the relay before declaring the session missing.
        // Rate-limited: the relay re-offers a turn we never /submitted on
        // every claim, and a full refreshBindings per offer (GET /sessions +
        // a PATCH per bound row + two orphan scans) ran as fast as the relay
        // answered, for as long as the message sat there (issue #114).
        if (Date.now() - lastBindingsRefresh > 30_000) {
          lastBindingsRefresh = Date.now();
          try { await refreshBindings(); } catch { /* transient */ }
        }
        session = localSession(offer.sessionId);
      }
      if (!session || session.status === "ended") {
        // No local runtime for this session (deleted window, dead daemon
        // generation). Leave the turn queued — honest visibility beats a
        // fabricated failure. The lane logs once; the human decides.
        if (!notedSkips.has(turnId)) {
          notedSkips.add(turnId);
          log(`turn ${turnId.slice(0, 8)}: no local session for v2 ${offer.sessionId.slice(0, 8)} — left queued, rechecking every ${SKIP_RECHECK_MS / 1000}s`);
        }
        skipUntil.set(turnId, Date.now() + SKIP_RECHECK_MS);
        return;
      }
      // `sess` is re-resolved by local id at every poll below: a restart
      // replaces the object under the same id, and polling the dead one
      // reported the interrupted turn "completed" the moment its busy()
      // dropped (codex review, 2026-09-04). Between the old object's end and
      // the replacement's creation the lookup misses and the old one — which
      // still says "pending" for the items it handed over — stands in.
      let sess: AgentSession = session;
      turnLocalId = session.id;
      const relive = () => { sess = registry.get(sess.id) ?? sess; };
      const promptKey = sessionKeys.get(offer.sessionId);
      const prompt = decodePrompt(offer.ciphertext, promptKey);
      if (prompt === null) {
        // Sealed with a key this daemon does not hold (a record rewrite, a
        // rotation it missed) — or PLAINTEXT offered to a sealed session,
        // which nothing authenticated (#579). Left queued, it blocked every
        // later message on the session behind it — for good (fny 867b15eb,
        // 2026-09-04). Fail it with the reason instead: the app shows it,
        // the user re-sends, the rest drains. Never dispatched.
        const reason = promptRejectReason(offer.ciphertext, promptKey);
        try {
          await api("POST", `/daemon/turns/${turnId}/submitted`, {}, leaseRef);
        } catch (e) {
          const gone = sessionGone(e);
          if (gone) { log(`turn ${turnId.slice(0, 8)}: /submitted refused (${gone}) — dropped`); return; }
          throw e;
        }
        await postTerminal(turnId, sess.id, {
          type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(),
          meta: { reason },
        }, leaseRef);
        log(`turn ${turnId.slice(0, 8)}: ${reason.replace(/_/g, " ")} → failed`);
        return;
      }
      try {
        await api("POST", `/daemon/turns/${turnId}/submitted`, {}, leaseRef);
      } catch (e) {
        // The session was archived/failed under us: the relay cancelled the
        // queued turn itself; the prompt never reaches the agent (#614).
        const gone = sessionGone(e);
        if (gone) { log(`turn ${turnId.slice(0, 8)}: /submitted refused (${gone}) — dropped, nothing dispatched`); return; }
        throw e;
      }

      // Materialize the cited attachments into the session's cwd BEFORE the
      // prompt goes in: each becomes a bare `./name` line the agent resolves
      // against its cwd. A prompt about a screenshot that lost the screenshot
      // is worse than an honest failure, so any fetch/open/write miss fails
      // the turn (submitted → failed) instead of dispatching a truncated ask.
      let text = prompt.text;
      const writtenAttachments: string[] = [];
      const dropFiles = () => { for (const abs of writtenAttachments.splice(0)) { try { unlinkSync(abs); } catch { /* already gone */ } } };
      if (prompt.attachments.length) {
        // The relay validated + pinned the OUTER id list (the offer); the
        // sealed citations are what the sender meant. Only their intersection
        // is trusted: a citation the relay never saw for this session is
        // refused rather than fetched on account scope alone.
        // The download is the one window before the command row exists: a
        // control-lane cancel that lands during it aborts the preparation
        // here (nothing is ever accepted, the files come back out); from the
        // accept on, a cancel is the coordinator's durable flag (#77).
        let cancelledWhilePreparing = false;
        preparing.set(turnId, () => { cancelledWhilePreparing = true; });
        const authorized = new Set((offer.attachments ?? []).map((x) => x.id));
        const paths: string[] = [];
        // Half-materialized prompts are worse than none — a failed turn must
        // not leave files the agent never heard about in the cwd.
        const fail = async (reason: string, a: PromptAttachment) => {
          dropFiles();
          await postTerminal(turnId, sess.id, {
            type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(), meta: { reason, attachmentId: a.id },
          }, leaseRef);
          log(`turn ${turnId.slice(0, 8)}: ${reason} (${a.name}) → failed`);
        };
        try {
          for (const a of prompt.attachments) {
            if (!authorized.has(a.id)) return fail("attachment_not_authorized", a);
            let path: string | null = null;
            let reason = "attachment_fetch_failed";
            try {
              const sealed = await fetchAttachment(a.id);
              if (cancelledWhilePreparing) break;
              const bytes = openAttachmentBytes(sealed, sessionKeys.get(offer.sessionId));
              if (bytes) { reason = "attachment_write_failed"; path = writeAttachmentToCwd(sess.cwd, bytes, a.name); }
              else reason = "attachment_open_failed";
            } catch (e) {
              log(`turn ${turnId.slice(0, 8)}: attachment ${a.id.slice(0, 8)} (${a.name}): ${(e as Error).message}`);
            }
            if (cancelledWhilePreparing) break;
            if (!path) return fail(reason, a);
            paths.push(path);
            writtenAttachments.push(join(sess.cwd, path.slice(2)));
          }
        } finally { preparing.delete(turnId); }
        if (cancelledWhilePreparing) {
          // Cancelled while we were preparing it: never accepted, and the
          // files we materialized for it come back out.
          dropFiles();
          await postTerminal(turnId, sess.id, { type: "terminal", terminalState: "cancelled", runtimeEventId: randomUUID(), meta: { reason: "cancelled_before_enqueue" } }, leaseRef);
          log(`turn ${turnId.slice(0, 8)}: cancelled before enqueue → cancelled`);
          return;
        }
        const uncited = [...authorized].filter((id) => !prompt.attachments.some((a) => a.id === id));
        if (uncited.length) log(`turn ${turnId.slice(0, 8)}: ${uncited.length} offered attachment(s) not cited in the sealed prompt — ignored`);
        text = `${text}\n${paths.join("\n")}`;
        log(`turn ${turnId.slice(0, 8)}: materialized ${paths.length} attachment(s) in ${sess.cwd}`);
      }

      // The command row carries the relay turn: a re-offer dedupes on it and
      // every later line for this turn names the session AND the command, so
      // "turn X completed" can be tied to the message it carried.
      const accepted = queueFor(sess).accept(text, { source: "rpc", visible: false, mirrorToRelay: false, relayTurnId: turnId, relayCommandId: offer.commandId });
      activeTurns.set(turnId, { localId: sess.id, commandId: accepted.id, lease: leaseRef, started: false });
      const tag = `turn ${turnId.slice(0, 8)} [${sess.id}/${accepted.id}]`;

      // A joy-owned slash command (/title, /joy-prompt, …) is executed at
      // accept time and never dispatched, so there is no delivery to wait
      // for. Close the turn now: parked in the gates below it would hold the
      // session's relay execution slot with every later message stuck
      // behind it (live 2026-09-03).
      if (accepted.handled === "command") {
        try {
          await postStart(turnId, sess.id, accepted.id, leaseRef);
        } catch (e) {
          if ((e as { status?: number }).status === 409) {
            // The relay refuses the start (cancelled): a /joy-prompt may have
            // queued its reinjection already — cancel it, then say cancelled.
            const rein = accepted.reinjectionId;
            let plucked = false;
            if (rein) { try { plucked = queueFor(sess).cancel(rein); } catch { /* stub adapters */ } }
            // A reinjection already admitted (nothing left to pluck) is
            // interrupted like an ordinary rejected start. A command that
            // queued no work (/title) aborts nothing — that interrupted an
            // unrelated terminal-started turn (Astra on 78a0abb6).
            if (rein && !plucked) { try { await sess.abort(); } catch { /* pane teardown */ } }
            dropFiles();
            await postTerminal(turnId, sess.id, { type: "terminal", terminalState: "cancelled", runtimeEventId: randomUUID(), meta: { reason: sessionGone(e) ?? "start_rejected", detail: (e as Error).message.slice(0, 200) } }, leaseRef);
            log(`${tag}: /start refused for a handled command (${sessionGone(e) ?? "cancelled"}) → cancelled`);
            return;
          }
          throw e;
        }
        await postTerminal(turnId, sess.id, {
          type: "terminal", terminalState: "completed", runtimeEventId: randomUUID(),
          meta: { reason: "handled_as_command" },
        }, leaseRef);
        log(`${tag}: handled as a joy command → completed`);
        return;
      }
      log(`${tag}: prompt staged (chars=${text.length})`);
      await driveTurn(turnId, sess.id, accepted.id, leaseRef, { startPosted: false, dropFiles, tag });
    } catch (e) {
      log(`turn ${turnId.slice(0, 8)} error: ${String(e)}`);
      // Best-effort: leave the relay a terminal instead of a forever-running
      // turn (with a live lease the sweep will never orphan it). If this post
      // also fails, lease death eventually orphans the turn — still honest.
      try {
        await postTerminal(turnId, turnLocalId, {
          type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(),
          meta: { reason: "lane_error", detail: String(e).slice(0, 300) },
        }, leaseRef);
      } catch { /* covered by lease-expiry orphaning */ }
    } finally {
      inFlight.delete(turnId);
      activeTurns.delete(turnId);
    }
  }

  /** The turn's terminal fact from the command's state: failed stays
   *  failed, interrupted stays interrupted (#463); the command's terminal
   *  reason is the fact's `meta.reason`. */
  const terminalBody = (state: CommandState, reason?: string | null): Record<string, unknown> => ({
    type: "terminal", terminalState: state, runtimeEventId: randomUUID(),
    ...(state !== "completed" && reason ? { meta: { reason } } : {}),
  });

  /** Drive an accepted command's relay turn to its terminal: wait for the
   *  command to run (its delivery is proven by the driver's echo — no
   *  "busy()" guess, no 180 s activity gate), POST /start, wait for the
   *  terminal state and post it. The states are the ledger's, so this loop
   *  can be resumed from the row after a daemon restart (R13). */
  async function driveTurn(turnId: string, localId: string, commandId: string, leaseRef: Lease, opts: { startPosted: boolean; resumed?: boolean; dropFiles?: () => void; tag: string }): Promise<void> {
    const { tag } = opts;
    const sessionNow = () => registry.get(localId);
    // The command is the coordinator's whatever object (or none) is under
    // the id right now — a restart replaces it.
    const q = () => queueFor({ id: localId });
    const finish = async (state: CommandState, reason?: string | null) => {
      if (state !== "completed") opts.dropFiles?.();
      await postTerminal(turnId, localId, terminalBody(state, reason), leaseRef);
      log(`${tag} ${state}${state !== "completed" && reason ? ` (${reason})` : ""}`);
    };
    /** The prompt is running locally but the relay will not have it: cancel
     *  it (the coordinator interrupts and retries) and say cancelled — never
     *  `failed`; the relay leaves executing turns to their owner. */
    const cancelLocally = async (reason: string) => {
      q().cancel(commandId);
      try { await sessionNow()?.abort(); } catch { /* pane teardown */ }
      await finish("cancelled", reason);
    };
    let startPosted = opts.startPosted;
    // The relay could not answer this turn's adoption (mirrors the loop
    // entry's marker, which the sweep shares): no /start until it can.
    let adoptionPending = false;
    /** The relay ANSWERED the adoption question — whatever the answer: the
     *  shared `adoption_pending` marker (the loop entry the sweep reads too)
     *  comes off. Clearing it only for `running` (Astra, F21) left a
     *  `cancelling` or terminal answer parked: the loop's next pass saw the
     *  marker still set and asked again at once — twelve adoptions in one
     *  burst against a relay that had closed the turn, until the 30-minute
     *  cap — and its stale sliced wait hid the runtime's own terminal. */
    const adoptionResolved = () => { const t = activeTurns.get(turnId); if (t?.adoptionPending) t.adoptionPending = null; };
    /** Act on the relay's adoption answer. `continue` → the loop goes on to
     *  the terminal; `done` → the turn is closed here; `none` → the relay
     *  had nothing to adopt (the caller decides); `pending` → the relay
     *  could not answer: the runtime keeps running, the turn is
     *  `adoption_pending` and Phase C keeps retrying. Every answer but
     *  `pending` is a resolution and clears the pending marker. */
    const honourAdoption = async (a: Adoption, via: string): Promise<"continue" | "done" | "none" | "pending"> => {
      if (a.kind !== "unavailable") adoptionResolved();
      switch (a.kind) {
        case "running":
          log(`${tag}: adopted on the relay under this lease (${via})`);
          return "continue";
        case "refused":
          // The relay's authoritative no — the session is closed under the
          // turn, or the budget failed it before its first start (#613): the
          // same cancel class a /start refusal carries.
          await cancelLocally(a.code);
          log(`${tag}: adoption refused by the relay (${a.code}, ${via}) → cancelled locally`);
          return "done";
        case "unavailable":
          // Unresolved: the relay said nothing about the turn. A runtime the
          // driver confirmed running is never cancelled on a relay outage.
          noteAdoptionPending(turnId, a.detail);
          log(`${tag}: the relay cannot answer the adoption (${a.detail}, ${via}) — adoption_pending, the command keeps running; retrying every ${ADOPTION_PENDING_RETRY_MS / 1000}s`);
          return "pending";
        case "cancelling":
          // The relay had a cancel requested for it — preserved through the
          // adoption: honour it here, ONCE (the ledger's cancel flag is
          // idempotent; a re-offer or a second answer adds nothing); the
          // coordinator interrupts and the turn ends cancelled through Phase C.
          log(`${tag}: adopted on the relay with a cancel pending (${via}) → cancelling locally`);
          q().cancel(commandId);
          return "continue";
        case "terminal":
          if (a.terminalState === "cancelled") {
            await cancelLocally("relay_cancelled");
            log(`${tag}: the relay closed this turn cancelled (${via}) → cancelled locally`);
            return "done";
          }
          // The relay closed the turn without us (an earlier generation's
          // sweep, an operator): completed / failed / interrupted. The agent
          // is still working on it here — a recovery 409 is no proof that a
          // runtime should be cancelled. It keeps running; its outcome is
          // reported through the terminal fact when it ends (the relay
          // answers replay), and no /start is posted for a closed turn. The
          // answer is honoured ONCE: the turn is never re-adopted after it.
          log(`${tag}: the relay already closed this turn ${a.terminalState} (${via}) — the local command keeps running; its outcome posts as the terminal fact`);
          startPosted = true;
          return "continue";
        case "none":
          return "none";
      }
    };
    if (!startPosted || opts.resumed) {
      // Phase A — OUR prompt reaches the agent and its turn is running. A
      // message legitimately queued behind a long turn must not time out,
      // so the wait is as long as the turn itself may run. A resumed turn
      // waits here even with its /start acknowledged: adopting it on the
      // relay (below) is right only once the new driver generation has
      // confirmed the runtime is executing it.
      const r = await q().waitFor(commandId, ["running", ...TERMINAL_STATES], { timeoutMs: TURN_CAP_MS });
      if (r.state === null) return finish("failed", "command_lost");
      if (isTerminal(r.state)) return finish(r.state, r.reason);
      if (r.state !== "running") {
        // Still not delivered at the cap: nothing will run it now.
        q().cancel(commandId);
        try { await sessionNow()?.abort(); } catch { /* pane teardown */ }
        return finish("failed", "dispatch_timeout");
      }
      if (!startPosted) log(`${tag}: started (delivery confirmed)`);
      // The adapter's verdicts count from DELIVERY, not from the relay's
      // acknowledgement of it (#584 residual, Astra on 81386fd0). This used
      // to be set after the /start round trip below, so a legacy adapter that
      // emitted `turn-end failed` while /start was in flight had its verdict
      // discarded and the lane terminalized `completed` on idle alone — the
      // relay's response time deciding whether an already-executed failure
      // counted. The prompt is running the moment the delivery is confirmed;
      // every turn-end from here belongs to THIS relay turn.
      { const t = activeTurns.get(turnId); if (t) t.started = true; }
      if (opts.resumed) {
        // A resumed turn is a previous daemon generation's on the relay:
        // dispatching/running under the old epoch, or already orphaned by
        // the sweep. The runtime is confirmed running here, so ADOPT it
        // under this lease instead of letting the orphan pass terminalize
        // it — that was the restart that cancelled a live agent (Astra, C9).
        // A relay that has nothing to adopt (or no such resolution) leaves
        // the plain path: /start under the stable event id, or none if acked.
        // An unavailable answer (5xx, transport) is retried with a bounded
        // backoff first; past it the turn is `adoption_pending` — NOT "none":
        // a /start posted then would 409 (orphaned / no current delivery) and
        // that refusal used to cancel the surviving runtime (Astra, F14).
        const a = await adoptWithBackoff(turnId, leaseRef, "daemon_restart", tag);
        const v = await honourAdoption(a, "resumed");
        if (v === "done") return;
        if (v === "pending") adoptionPending = true;
      }
      if (!startPosted && !adoptionPending) {
        try {
          await postStart(turnId, localId, commandId, leaseRef);
        } catch (e) {
          const st = (e as { status?: number }).status;
          if (st !== 409) throw e;
          const code = (e as { relayError?: string }).relayError ?? "";
          // The relay refuses the start. A cancellation that beat the
          // control offer here, or a session that is over (#614): cancel
          // locally. Any OTHER refusal (turn_terminal, no_current_delivery,
          // turn_orphaned_reconcile_first) is a recovery question — the
          // turn is a predecessor's, or the relay already closed it — and
          // the relay's reconcile answers it; a running agent is never
          // cancelled on that 409 alone — and never on the relay failing to
          // answer the question either (unavailable → adoption_pending).
          let verdict: "continue" | "done" | "none" | "pending" = "none";
          if (!START_CANCEL_CLASS.has(code)) {
            const a = await adoptWithBackoff(turnId, leaseRef, "start_refused", tag);
            verdict = await honourAdoption(a, "after /start refused");
            if (verdict === "done") return;
            if (verdict === "pending") adoptionPending = true;
            if (a.kind === "running") {
              try { await postStart(turnId, localId, commandId, leaseRef); }
              catch (e3) {
                if ((e3 as { status?: number }).status !== 409) throw e3;
                await cancelLocally(sessionGone(e3) ?? "start_rejected");
                log(`${tag}: /start refused again after adoption (${(e3 as Error).message}) → cancelled locally`);
                return;
              }
            }
          }
          if (verdict === "none") {
            await cancelLocally(sessionGone(e) ?? "start_rejected");
            log(`${tag}: /start refused (${(e as Error).message}) → cancelled locally`);
            return;
          }
        }
      }
    }
    { const t = activeTurns.get(turnId); if (t) t.started = true; } // idempotent: also covers a resumed turn whose /start was already posted (#584)

    // Phase C — the command's terminal IS the turn's: completed/failed from
    // the runtime's turn-end, cancelled once the interrupt is confirmed,
    // interrupted on idle-without-terminal, a restart or a kill (#463).
    // While the adoption is pending the wait is sliced: every
    // ADOPTION_PENDING_RETRY_MS the relay is asked again (the sweep may have
    // adopted it meanwhile — the marker on the loop entry is shared); once
    // the relay has ANSWERED — adopted, cancelling, or a terminal it already
    // holds — the marker is off, the /start still owed is posted (a replay
    // on the relay; the durable ack lands) and the loop returns to one fresh
    // bounded wait for the command's own terminal. No answer is acted on
    // twice: a resolved turn is never re-adopted (Astra, F21).
    const capAt = Date.now() + TURN_CAP_MS;
    let done = await q().waitFor(commandId, TERMINAL_STATES, { timeoutMs: adoptionPending ? Math.min(ADOPTION_PENDING_RETRY_MS, TURN_CAP_MS) : TURN_CAP_MS });
    while (done.state !== null && !isTerminal(done.state) && Date.now() < capAt) {
      const entry = activeTurns.get(turnId);
      if (!entry?.adoptionPending) {
        // The relay answered (here or through the sweep), or nothing was
        // ever pending: finish the owed /start, then wait out the turn.
        adoptionPending = false;
        if (!startPosted) {
          try { await postStart(turnId, localId, commandId, leaseRef); startPosted = true; }
          catch (e) { if ((e as { status?: number }).status !== 409) throw e; log(`${tag}: /start after the adoption refused (${errText(e)}) — the relay has its answer; the outcome posts as the terminal fact`); startPosted = true; }
        }
        done = await q().waitFor(commandId, TERMINAL_STATES, { timeoutMs: Math.max(0, capAt - Date.now()) });
        continue;
      }
      const a = await adoptRelayTurn(turnId, leaseRef, "adoption_retry");
      const v = await honourAdoption(a, `retry ${entry.adoptionPending.attempts}`);
      if (v === "done") return;
      if (v === "continue") {
        // Resolved (running / cancelling / a remote terminal): the marker is
        // off, so the next pass takes the plain branch above — the owed
        // /start (none for a closed turn), then ONE fresh wait to the cap.
        adoptionPending = false;
        if (a.kind === "terminal") startPosted = true; // closed elsewhere: no /start for a closed turn
        continue;
      }
      if (v === "none") {
        // Nothing to adopt any more (another turn is active, or the relay
        // no longer holds it as a predecessor's) — a question the relay
        // answered, not a cancel: the runtime finishes, its terminal posts.
        adoptionPending = false;
        log(`${tag}: nothing left to adopt on the relay (${a.kind === "none" ? a.detail ?? "none" : a.kind}) — the command keeps running; its outcome posts as the terminal fact`);
        startPosted = true;
        continue;
      }
      done = await q().waitFor(commandId, TERMINAL_STATES, { timeoutMs: Math.min(ADOPTION_PENDING_RETRY_MS, Math.max(0, capAt - Date.now())) });
    }
    if (done.state === null) return finish("failed", "command_lost");
    if (!isTerminal(done.state)) {
      // Stop the REAL agent too — reporting interrupted while the agent
      // keeps burning would be a lie with a bill attached.
      q().cancel(commandId);
      try { await sessionNow()?.abort(); } catch { /* pane teardown */ }
      await finish("interrupted", "turn_cap");
      log(`${tag}: 30min cap → interrupted (agent aborted)`);
      return;
    }
    await finish(done.state, done.reason);
  }

  /** A relay turn the ledger still carries for a session with no loop here
   *  (the previous daemon accepted it): pick it up where its state says. */
  async function resumeTurn(row: CommandRow, leaseRef: Lease): Promise<void> {
    const turnId = row.relayTurnId!;
    if (inFlight.has(turnId)) return;
    inFlight.add(turnId);
    // Whether the relay saw /start is the ACK receipt, never the local state:
    // a daemon that died between the driver's echo (row running) and the
    // POST looks exactly like one that died after it (Astra on edd69fd1).
    // No ack → posted again under the stable event id (a relay that has it
    // answers replay; one that never got it starts the turn now).
    const started = startAcked(row.sessionId, turnId);
    activeTurns.set(turnId, { localId: row.sessionId, commandId: row.id, lease: leaseRef, started });
    const tag = `turn ${turnId.slice(0, 8)} [${row.sessionId}/${row.id}]`;
    log(`${tag}: resumed from the ledger (${row.state}, /start ${started ? "acknowledged" : ledger.hasReceipt(row.sessionId, START_INTENT_RECEIPT, turnId) ? "intended, unacknowledged — re-posting" : "not yet posted"})`);
    try {
      await driveTurn(turnId, row.sessionId, row.id, leaseRef, { startPosted: started, resumed: true, tag });
    } catch (e) {
      log(`${tag} error: ${String(e)}`);
      try { await postTerminal(turnId, row.sessionId, { type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(), meta: { reason: "lane_error", detail: String(e).slice(0, 300) } }, leaseRef); } catch { /* lease-expiry orphaning */ }
    } finally {
      inFlight.delete(turnId);
      activeTurns.delete(turnId);
    }
  }

  /** Boot (R13): every relay turn the ledger holds for a coordinator-driven
   *  session gets its loop back, and a terminal reached while no loop was
   *  alive (a kill, a restart's interrupted{restart}) gets its terminal row.
   *  The row's id is the stable `term:<turn>`, so this never doubles one. */
  function resumeLedgerTurns(leaseRef: Lease): void {
    const sessions = (registry as { list?: () => AgentSession[] }).list?.() ?? [];
    for (const s of sessions) {
      for (const row of ledger.listCommands(s.id)) {
        if (!row.relayTurnId) continue;
        if (isTerminalState(row.state)) { materializeLedgerTerminal(row, s.id); continue; }
        if (!inFlight.has(row.relayTurnId)) void resumeTurn(row, leaseRef);
      }
    }
  }
  /** A relay turn whose command the ledger closed with no terminal row in
   *  the outbox (the process died between the two commits): the row is
   *  DERIVED from the command — its state, its terminal reason — and
   *  committed under the stable `term:<turn>` id, so it lands once and the
   *  sender resolves the turn with the recorded outcome (reconcile with
   *  `replayed`, a previous generation's terminal). Runs before any orphan
   *  cleanup (refreshBindings), again from the resume pass and the sweep;
   *  every caller is idempotent. Returns true when a row was written now. */
  function materializeLedgerTerminal(row: CommandRow, localId: string): boolean {
    const turnId = row.relayTurnId;
    if (!turnId || !isTerminalState(row.state)) return false;
    if (ledger.hasOutboundEvent(`term:${turnId}`)) return false;
    if (unpersisted.some((r) => r.runtimeEventId === `term:${turnId}`)) return false; // held in memory, awaiting the ledger
    log(`turn ${turnId.slice(0, 8)} [${localId}/${row.id}]: ${row.state} in the ledger with no terminal row — posting it (previous daemon died before it could)`);
    const seqs = commitOutbound([{
      sessionId: localId, kind: "terminal", runtimeEventId: `term:${turnId}`, relayTurnId: turnId,
      v2SessionId: boundByLocal.get(localId) ?? null, sealed: false, body: terminalBody(row.state, row.terminalReason),
    }]);
    if (seqs) sender.wake(localId);
    return true;
  }
  /** Every terminal command of ONE local session that still owes its relay
   *  turn a terminal row gets it derived (idempotent). Works from the ledger
   *  alone — no live handle needed (Astra, F21). */
  function materializeLedgerTerminalsFor(localId: string): void {
    let rows: CommandRow[];
    try { rows = ledger.listCommands(localId); } catch { return; } // unreadable: the next pass retries
    for (const row of rows) if (row.relayTurnId && isTerminalState(row.state)) materializeLedgerTerminal(row, localId);
  }
  /** The same across every session the ledger may hold commands for: the
   *  live handles, the window records (a session that ended or died while
   *  the daemon was down exists only there), and the relay's own rows for
   *  this daemon (`rows`) — so a saved outcome is derived BEFORE the boot
   *  archives a record-only session, not lost to that archive (Astra, F21). */
  function materializeLedgerTerminals(rows: Array<{ daemonId: string; localSessionId?: string | null }> = []): void {
    const ids = new Set<string>();
    for (const s of (registry as { list?: () => AgentSession[] }).list?.() ?? []) ids.add(s.id);
    try { for (const rec of registry.listRecords()) ids.add(rec.id); } catch { /* records unreadable: the relay rows still name the sessions */ }
    for (const s of rows) if (s.daemonId === machineId && s.localSessionId) ids.add(s.localSessionId);
    for (const id of ids) materializeLedgerTerminalsFor(id);
  }
  /** Does the session still have a terminal row the relay has not acked
   *  (a saved outcome whose delivery is arranged but not landed)? A row the
   *  relay refused for good is settled as dropped and owes nothing. An
   *  outbox the ledger cannot READ is an unknown, never a clean slate: the
   *  archive waits for the next pass rather than overtake an outcome. */
  const owesTerminal = (localId: string): boolean => {
    try { return ledger.pendingOutbound(localId).some((r) => r.kind === "terminal"); } catch { return true; }
  };
  /** Is a relay turn's command still pending in the ledger (a worker here)? */
  const pendingLedgerTurn = (turnId: string): boolean => { const r = ledger.commandForRelayTurn(turnId); return !!r && !isTerminalState(r.state); };

  /** Returns true when this offer was NEW (acted on), false for a re-offer
   *  of a cancel we already handled — the caller uses that to back off. */
  async function handleCancel(offer: ControlOffer, leaseRef: Lease): Promise<boolean> {
    const turnId = offer.targetTurnId;
    // Mark handled only AFTER the receipt ack lands — a transient /received
    // failure must leave the offer eligible for the relay's re-offer, not
    // suppressed until turn cleanup.
    await api("POST", `/daemon/deliveries/${offer.deliveryId}/received`, {}, leaseRef);
    // A turn with a command row: the cancel is the row's durable flag (R9).
    // Queued → cancelled at once; running → cancelling, the coordinator
    // interrupts and retries until the runtime confirms (R10). A re-offer of
    // a cancel already requested is not new work.
    const row = ledger.commandForRelayTurn(turnId);
    if (row) {
      if (isTerminalState(row.state)) return false;
      const fresh = row.cancelRequestedAt == null;
      if (!fresh) return false;
      const r = coordinator.cancel(row.id);
      log(`cancel ${turnId.slice(0, 8)}: ${row.id} ${r.kind}`);
      return true;
    }
    // Still materializing attachments: abort the preparation (never accepted).
    const prep = preparing.get(turnId);
    if (prep) { prep(); log(`cancel ${turnId.slice(0, 8)}: aborted during attachment download`); return true; }
    // No row and nothing preparing: this turn never reached the coordinator
    // here (a previous daemon's, or never offered) — nothing runs for it;
    // received, and the relay resolves it when the turn is reconciled.
    return false;
  }

  const isLeaseDeath = (e: unknown) =>
    /lease_unknown|lease_expired|lease_epoch_stale/.test(String(e));

  function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
    });
  }

  // Relay row for a session the daemon started itself. The relay's
  // createSession supports mode "announce_existing": the row is inserted
  // already bound to this daemon (local id + key envelope, state "starting"),
  // no spawn command involved. creationIntentId = the local id, so the call
  // is idempotent (a replay returns the same sessionId).
  const announcing = new Set<string>();
  // Local sessions a spawn is mid-way through binding. The announce pass
  // must never touch these: it saw a spawn's freshly created session as
  // "live and unbound" (bind not landed yet), announced it, and the spawn's
  // own bind then hit the relay's (daemon, local id) unique constraint on
  // every retry, forever (fny 001c4d93/153f92a0, 2026-09-04).
  const spawning = new Set<string>();
  // Announcing awaits the relay twice (the recovered-row GET, the POST); a
  // kill can land in either window. Every persist/bind is fenced on THIS
  // session handle still being the registry's live one: an announce that
  // went on after the kill rebound the dead identity to a fresh row and
  // recreated the record just deleted — the killed session came back as an
  // unkillable card (Astra on 81386fd0, #120).
  const stillLive = (session: AgentSession): boolean =>
    registry.get(session.id) === session && (session.status === "active" || session.status === "starting");
  /** A handle the registry keeps after a kill (dedup/recovery bookkeeping):
   *  not live, not listed, no card publisher of its own. */
  const isKilledHandle = (s: AgentSession): boolean => s.status === "ended" && s.endReason === "killed";

  // ── Archiving a replacement row nobody will ever own (#120) ──────────────
  // A session killed while its announce was in flight leaves the relay
  // holding a row for a session that no longer exists; its owner daemon is
  // us, so nothing else can archive it. The archive used to be ONE attempt:
  // a transient failure (503, lane down) logged and dropped the intent, and
  // reconcileOrphans then skipped the row because the registry still held
  // the killed handle — the row stayed `starting`, unowned, for good (Astra
  // on 2615f870). The intent is now a ledger job (keyed by the RELAY row, so
  // forgetting the local session's rows does not forget it), retried with
  // backoff until the relay confirms — or reports the row gone/settled —
  // across lane restarts too: every boot pass and refresh runs the owed
  // archives before it sweeps orphans.
  const ARCHIVE_JOB_KIND = "archive_relay_row";
  const ARCHIVE_RETRY_MIN_MS = opts.archiveRetryMs?.min ?? 2_000;
  const ARCHIVE_RETRY_MAX_MS = opts.archiveRetryMs?.max ?? 60_000;
  interface ArchiveRowJob { v2SessionId: string; localSessionId: string; card: Record<string, unknown>; keyB64: string | null }
  const pendingArchives = new Map<string, ArchiveRowJob>();
  const archiveAttempts = new Map<string, number>();
  let archiveRetryTimer: ReturnType<typeof setTimeout> | null = null;
  const archiveJobId = (v2SessionId: string) => `archive:${v2SessionId}`;
  /** Merge the persisted intents into the working set (a previous lane
   *  generation's, or this one's after a restart). */
  function loadPersistedArchives(): void {
    let jobs: JobRow[] = [];
    try { jobs = ledger.listJobs(ARCHIVE_JOB_KIND); } catch { return; }
    for (const j of jobs) {
      const p = j.payload as Partial<ArchiveRowJob> | null;
      if (!p || typeof p.v2SessionId !== "string" || typeof p.localSessionId !== "string" || !p.card || typeof p.card !== "object") continue;
      if (!pendingArchives.has(p.v2SessionId)) pendingArchives.set(p.v2SessionId, { v2SessionId: p.v2SessionId, localSessionId: p.localSessionId, card: p.card as Record<string, unknown>, keyB64: typeof p.keyB64 === "string" ? p.keyB64 : null });
    }
  }
  /** One attempt. True once the intent is settled: the relay took the
   *  archive, or the row is gone / already terminal — nothing left to do. */
  async function runArchiveJob(job: ArchiveRowJob): Promise<boolean> {
    const l = lease;
    if (!l) return false;
    if (owesTerminal(job.localSessionId)) {
      // The saved outcome goes first (Astra, F21): the sender is delivering
      // it; this attempt counts and the backoff retries the archive after.
      archiveAttempts.set(job.v2SessionId, (archiveAttempts.get(job.v2SessionId) ?? 0) + 1);
      return false;
    }
    const key = job.keyB64 ? new Uint8Array(Buffer.from(job.keyB64, "base64")) : null;
    try {
      // Seals INSIDE the try: an unreadable budget record is a failed
      // attempt like any other — the job stays, the backoff retries it —
      // never a clean card that drops the warning.
      const sealed = sealSessionCard(job.localSessionId, job.v2SessionId, job.card, key);
      await withTimeout(api("PATCH", `/daemon/sessions/${job.v2SessionId}`, { encryptedMetadata: sealed.encryptedMetadata, state: "archived" }, l), 15_000);
      markBudgetPublished(job.v2SessionId, sealed.carried);
      log(`archived replacement row ${job.v2SessionId.slice(0, 8)} for ended session ${job.localSessionId}`);
    } catch (e) {
      if (!isRowGone(e) && !sessionGone(e)) {
        const n = (archiveAttempts.get(job.v2SessionId) ?? 0) + 1;
        archiveAttempts.set(job.v2SessionId, n);
        if (!(e instanceof BudgetUnreadableError)) log(`archive ${job.v2SessionId.slice(0, 8)} failed (attempt ${n}, will retry): ${e instanceof Error ? e.message : e}`);
        return false;
      }
      log(`archive ${job.v2SessionId.slice(0, 8)}: row already gone or settled — nothing to do`);
    }
    pendingArchives.delete(job.v2SessionId);
    archiveAttempts.delete(job.v2SessionId);
    try { ledger.deleteJob(archiveJobId(job.v2SessionId)); } catch { /* re-run settles it again, harmlessly */ }
    return true;
  }
  /** Run every owed archive once; returns the row ids settled this pass. */
  async function retryPendingArchives(): Promise<Set<string>> {
    loadPersistedArchives();
    const settled = new Set<string>();
    for (const job of [...pendingArchives.values()]) {
      if (stopped) break;
      if (await runArchiveJob(job)) settled.add(job.v2SessionId);
    }
    return settled;
  }
  /** Back off from the youngest owed row's attempt count (2s … 60s). */
  function scheduleArchiveRetry(): void {
    if (stopped || archiveRetryTimer || pendingArchives.size === 0) return;
    const attempts = Math.min(...[...pendingArchives.keys()].map((v2) => archiveAttempts.get(v2) ?? 0));
    const delay = Math.min(ARCHIVE_RETRY_MAX_MS, ARCHIVE_RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1));
    archiveRetryTimer = setTimeout(() => {
      archiveRetryTimer = null;
      void retryPendingArchives().then(() => scheduleArchiveRetry(), () => scheduleArchiveRetry());
    }, delay);
    archiveRetryTimer.unref?.();
  }
  /** Owe an archive WITHOUT attempting it now (its card cannot be sealed
   *  truthfully yet): persist the intent, count the attempt, and leave it to
   *  the retry loop's backoff. */
  function deferArchive(job: ArchiveRowJob): void {
    pendingArchives.set(job.v2SessionId, job);
    archiveAttempts.set(job.v2SessionId, (archiveAttempts.get(job.v2SessionId) ?? 0) + 1);
    try { ledger.putJob({ id: archiveJobId(job.v2SessionId), sessionId: job.v2SessionId, kind: ARCHIVE_JOB_KIND, payload: job }); }
    catch (e) { log(`archive ${job.v2SessionId.slice(0, 8)}: intent not persisted (${e instanceof Error ? e.message : e}) — retrying in memory only`); }
    scheduleArchiveRetry();
  }
  /** Persist the intent FIRST (a crash between the POST and the PATCH must
   *  not lose it), try once now, and leave the rest to the retry loop. */
  async function archiveReplacementRow(job: ArchiveRowJob): Promise<void> {
    pendingArchives.set(job.v2SessionId, job);
    try { ledger.putJob({ id: archiveJobId(job.v2SessionId), sessionId: job.v2SessionId, kind: ARCHIVE_JOB_KIND, payload: job }); }
    catch (e) { log(`archive ${job.v2SessionId.slice(0, 8)}: intent not persisted (${e instanceof Error ? e.message : e}) — retrying in memory only`); }
    if (!(await runArchiveJob(job))) scheduleArchiveRetry();
  }

  async function announceLocalSession(session: AgentSession): Promise<void> {
    if (!lease || boundByLocal.has(session.id) || announcing.has(session.id)) return;
    if (!stillLive(session)) return;
    announcing.add(session.id);
    try {
      const rec = registry.listRecords().find((r) => r.id === session.id);
      if (rec?.v2SessionId && deadRows.get(session.id) !== rec.v2SessionId) {
        // Bound before (a recovered record). The relay did not list this row
        // (refreshBindings would have bound it) — confirm it still exists
        // before trusting the record (#120): a 404 means the card was deleted
        // while we were unreachable, and re-binding would park the live
        // agent behind a dead row for good.
        let gone = false;
        try { await withTimeout(api("GET", `/sessions/${rec.v2SessionId}`), 15_000); }
        catch (e) { gone = isRowGone(e); /* other failures: transient — trust the record for now */ }
        if (!stillLive(session)) { log(`${session.id}: ended while its relay row was being checked — not announced`); return; }
        if (!gone) {
          bound.set(rec.v2SessionId, session.id); boundByLocal.set(session.id, rec.v2SessionId);
          if (rec.v2SessionKey) sessionKeys.set(rec.v2SessionId, new Uint8Array(Buffer.from(rec.v2SessionKey, "base64")));
          wireCardPublisher(session.id, rec.v2SessionId);
          return;
        }
        deadRows.set(session.id, rec.v2SessionId);
        log(`${session.id}: relay row ${rec.v2SessionId.slice(0, 8)} from the window record no longer exists — announcing a fresh one`);
      }
      // A replacement for a deleted row needs a NEW creation intent: the old
      // one is idempotent by design and would replay the dead row's answer.
      const dead = deadRows.get(session.id);
      const creationIntentId = dead ? `announce:${session.id}:after:${dead.slice(0, 8)}` : `announce:${session.id}`;
      // Reuse an in-flight announce's key + envelope. The relay dedupes by
      // intent AND request hash, so a retry after a lost reply must repeat
      // the same envelope: a fresh key made every retry a 409
      // idempotency_mismatch and the session never bound (codex review,
      // 2026-09-04). Persisted BEFORE the POST for the same reason.
      let envelope = rec?.v2AnnounceEnvelope ?? "v2:plaintext";
      let key: Uint8Array | null = rec?.v2AnnounceEnvelope && rec.v2SessionKey ? new Uint8Array(Buffer.from(rec.v2SessionKey, "base64")) : null;
      if (!rec?.v2AnnounceEnvelope && opts.accountContentPublicKey) {
        key = new Uint8Array(randomBytes(32));
        envelope = sealSessionKey(key, opts.accountContentPublicKey);
        registry.saveRecord(session.id, { v2SessionKey: Buffer.from(key).toString("base64"), v2AnnounceEnvelope: envelope });
      }
      const r = await withTimeout(api("POST", "/sessions", {
        mode: "announce_existing", creationIntentId, daemonId: machineId,
        localSessionId: session.id, sessionKeyEnvelope: envelope,
      }), 15_000) as { sessionId?: string };
      const v2 = r?.sessionId;
      if (!v2) throw new Error("announce returned no sessionId");
      if (!stillLive(session)) {
        // Killed while the announce was in flight: the relay now holds a row
        // for a session that no longer exists and nothing else will ever
        // archive it (its owner daemon is us). Archive it here, bind nothing.
        log(`${session.id}: ended while being announced — archiving the replacement row ${v2.slice(0, 8)}`);
        if (key) sessionKeys.set(v2, key);
        const card = { path: session.cwd, host: hostname(), machineId, joy__state: "archived", joy__sessionId: session.id, v2: { sessionId: v2, relay: relayUrl, localSessionId: session.id } };
        await archiveReplacementRow({ v2SessionId: v2, localSessionId: session.id, card, keyB64: key ? Buffer.from(key).toString("base64") : null });
        return;
      }
      if (key) sessionKeys.set(v2, key);
      registry.saveRecord(session.id, { v2SessionId: v2, ...(key ? { v2SessionKey: Buffer.from(key).toString("base64") } : {}) });
      if (dead) deadRows.delete(session.id);
      bound.set(v2, session.id); boundByLocal.set(session.id, v2);
      session.setV2Link?.({ sessionId: v2, relay: relayUrl, keyEnvelope: envelope });
      wireCardPublisher(session.id, v2);
      log(`announced ${session.id} → v2 ${v2.slice(0, 8)} (${envelope.startsWith("v2sk1:") ? "sealed" : "plaintext"})`);
    } catch (e) {
      log(`announce ${session.id} failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      announcing.delete(session.id);
    }
  }
  async function announceUnboundSessions(): Promise<void> {
    // A session a spawn command created belongs to that command's relay
    // row — even across a daemon restart (the intent file remembers it).
    const spawned = new Set(ledger.listSpawnIntents().map((i) => i.localSessionId));
    const records = registry.listRecords();
    for (const s of registry.list()) {
      if (s.status !== "active" && s.status !== "starting") continue;
      if (boundByLocal.has(s.id) || spawning.has(s.id)) continue;
      // A spawn whose bind is still pending is its command's to bind. One
      // whose record already names a row completed that bind — if the relay
      // does not list it now, the row is gone (#120) and it needs a new one.
      if (spawned.has(s.id) && !records.find((r) => r.id === s.id)?.v2SessionId) continue;
      await announceLocalSession(s);
    }
  }

  // A session restarted in place: its running command ends interrupted
  // {restart} in the coordinator's retire — the turn loop reads the state;
  // nothing here has to guess from busy().
  // A daemon-created session (fork, teleport, a handoff target) can be bound
  // on demand instead of waiting for the next announce pass.
  (registry as { setAnnouncer?: (fn: (s: AgentSession) => Promise<void>) => void }).setAnnouncer?.((s) => announceLocalSession(s));

  async function renewLoop(): Promise<void> {
    // Renewal ONLY. It used to share a loop with the announce pass and the
    // orphan sweep, whose per-session requests (15s each, serial) could push
    // the next PUT past the relay's 20s TTL — expiring the very lease they
    // run under (codex review, 2026-09-04, second pass).
    while (!stopped) {
      await sleep(RENEW_MS);
      if (!lease) continue;
      try {
        const res = await fetch(`${relayUrl}/joy/v2/daemon/leases/${lease.leaseId}`, {
          method: "PUT",
          headers: { ...baseHeaders(), "x-joy-lease-token": lease.leaseToken },
          signal: AbortSignal.timeout(RENEW_MS),
        });
        if (!res.ok) throw new Error(`renew -> ${res.status}`);
      } catch {
        lease = null; // acquire loop below re-establishes
        freshTerminals.clear(); // whatever posts next does so under a new lease: reconcile, not facts
      }
    }
  }

  const noWorkerSeen = new Map<string, number>();
  async function sweepLoop(): Promise<void> {
    let ticks = 0;
    while (!stopped) {
      await sleep(RENEW_MS);
      if (!lease) continue;
      ticks += 1;
      // Sessions this daemon created ITSELF (joy new, fork, teleport, a
      // handoff target, a restart) have no relay row: nothing ever announced
      // them, so the app never saw a card and the lane dropped their output
      // (boundByLocal empty). Announce any live, unbound one — idempotent by
      // creation intent, so a retry after a failed announce is harmless.
      try { await announceUnboundSessions(); } catch { /* next tick */ }
      // Orphan sweep. The boot-time pass in refreshBindings runs BEFORE the
      // relay has orphaned the turn a restart interrupted — the old lease
      // takes up to its 20s TTL to expire first — so that pass finds nothing,
      // and with only the 15-tick (2 min) sweep after it every restart wedged
      // the mid-turn session for two minutes with the user's sends queued
      // behind it (this box, b52bf522, three times on 2026-09-03). Now every
      // tick reads the (cheap, single-request) session list and checks any
      // row that LOOKS wedged — work queued, nothing executing — which is
      // exactly what an orphaned turn looks like from the list; the full
      // per-session sweep stays on the slow cadence for the silent cases
      // (a fence violation with nothing queued).
      try {
        const r = await withTimeout(api("GET", "/sessions"), 10_000);
        const rows = (r.sessions ?? []) as Array<{ sessionId: string; daemonId: string; localSessionId?: string | null; queuedTurns?: number; executing?: string | null }>;
        const suspects = ticks % 15 === 0 ? rows : rows.filter((s) => (s.queuedTurns ?? 0) > 0 && !s.executing);
        if (suspects.length) await withTimeout(reconcileOrphanedTurns(suspects), 20_000);
        // A turn the relay shows EXECUTING with no worker here — its loop
        // died before the terminal landed and the retry gave up, or a
        // previous daemon generation's turn the relay never orphaned
        // because our lease renewals kept it alive. Nothing local will ever
        // release the slot; every later prompt queues behind it (#74). Two
        // consecutive sightings (a just-claimed turn is in inFlight before
        // the relay ever shows it executing) → release it as interrupted.
        // The list carries the execution STATE, not the turn id — fetch the
        // session for the id, then re-check the local guards against it.
        const seen = new Set<string>();
        for (const row of rows) {
          if (!row.executing || row.daemonId !== machineId || !row.localSessionId) continue;
          const st = await withTimeout(api("GET", `/sessions/${row.sessionId}`), 10_000).catch(() => null);
          const ex = (st?.execution as { state?: string; turnId?: string } | undefined);
          const turnId = ex?.turnId;
          if (!turnId || !ex?.state || !["dispatching", "running", "cancelling"].includes(ex.state)) continue;
          if (inFlight.has(turnId) || activeTurns.has(turnId) || ledger.hasTerminalFor(turnId) || pendingLedgerTurn(turnId)) continue;
          seen.add(turnId);
          const n = (noWorkerSeen.get(turnId) ?? 0) + 1;
          noWorkerSeen.set(turnId, n);
          if (n < 2 || !lease) continue;
          // Re-check after the await: a claim may have started it meanwhile.
          if (inFlight.has(turnId) || activeTurns.has(turnId) || pendingLedgerTurn(turnId)) { noWorkerSeen.delete(turnId); continue; }
          try {
            await api("POST", `/daemon/turns/${turnId}/reconcile`, { resolution: "terminal", terminalState: "interrupted", meta: { reason: "no_local_worker" } }, lease);
            log(`released turn ${turnId.slice(0, 8)} on ${row.sessionId.slice(0, 8)}: executing on the relay, no worker here → interrupted`);
          } catch (e) {
            log(`release of turn ${turnId.slice(0, 8)} failed: ${(e as Error).message}`);
          }
          noWorkerSeen.delete(turnId);
        }
        for (const k of [...noWorkerSeen.keys()]) if (!seen.has(k)) noWorkerSeen.delete(k);
        // Rows nobody is sending (a parked line, a deferred reconcile): wake them.
        sender.start();
        // Persistence health: rows the ledger refused are re-committed here;
        // the pressure half clears when every session's backlog is back
        // under the cap.
        retryUnpersisted();
        retryBudgetReads();
        for (const sid of [...overPressure]) notePressure(sid);
        publishOutboxHealth();
      } catch { /* next tick */ }
    }
  }

  async function laneLoop(lane: "work" | "control"): Promise<void> {
    let announced = false;
    while (!stopped) {
      try {
        if (!lease) {
          if (lane === "control") { await sleep(1_000); continue; } // work loop owns acquire
          await acquire();
          // The boot pass (bindings, keys, cards, orphan cleanup) consults
          // the LEDGER before it touches any orphaned turn: a turn whose
          // command is still pending here is a survivor, never interrupted
          // — its loop below adopts it under this lease once the driver
          // confirms the runtime running (Astra, C9).
          await refreshBindings();
          bootReady = true; // bindings + content keys loaded: the outbox may send
          sender.start(); // every session with unacked rows resumes from the ledger — in order
          resumeLedgerTurns(lease!); // relay turns the ledger still carries get their loops back (R13)
          announced = false;
        }
        const leaseRef = lease!;
        const offers = await claim(lane, leaseRef);
        let anyNew = offers.length === 0; // empty = the long-poll waited; no spin
        for (const offer of offers) {
          if (stopped) break;
          if (lane === "control") {
            if (await handleCancel(offer, leaseRef)) anyNew = true;
          } else if (offer.kind === "spawn_session") { await handleSpawn(offer, leaseRef); anyNew = true; }
          else if (offer.kind === "prompt") {
            // A turn we already looked at and left queued (no local runtime,
            // undecodable) comes back on every claim: it is not new work, and
            // treating it as such skipped the pause below — a hot loop (#114).
            const until = skipUntil.get(offer.turnId!);
            if (until !== undefined) { if (Date.now() < until) continue; skipUntil.delete(offer.turnId!); }
            if (inFlight.has(offer.turnId!)) continue; // still handling the previous offer of it
            // Backpressure: a session whose output backlog is over the cap
            // gets no new prompt until it drains — producing more output
            // that cannot leave the machine is the one thing that grows the
            // spool without bound (Astra, afb8ac84).
            const gatedLocal = bound.get(offer.sessionId);
            if (gatedLocal && notePressure(gatedLocal)) {
              publishOutboxHealth();
              if (!notedSkips.has(offer.turnId!)) { notedSkips.add(offer.turnId!); log(`turn ${offer.turnId!.slice(0, 8)}: ${gatedLocal} has ${ledger.outboundPressure(gatedLocal).rows} undelivered outputs — dispatch paused until they drain`); }
              skipUntil.set(offer.turnId!, Date.now() + SKIP_RECHECK_MS);
              continue;
            }
            void runTurn(offer, leaseRef); anyNew = true;
          }
        }
        // A standing offer we already handled returns INSTANTLY from claim —
        // without this pause the loop hot-polls until the turn terminalizes.
        if (!anyNew) await sleep(2_000);
      } catch (e) {
        if (isLeaseDeath(e)) {
          if (lane === "control") {
            // The control lane NEVER acquires. Its long-poll simply raced a
            // lease rotation by the work lane; nulling the shared lease here
            // made the two lanes re-acquire in a loop (observed live: epoch
            // climbing every few seconds). Drop this claim and pick up the
            // work lane's current lease on the next pass.
            await sleep(1_000);
            continue;
          }
          // Work lane: superseded (another daemon generation holds this
          // machineId) or expired. Back off with jitter so two daemons
          // misconfigured onto one machineId thrash slowly and VISIBLY.
          lease = null;
          freshTerminals.clear();
          log(`${lane} lane: lease lost (${String((e as Error).message ?? e)}) — re-acquiring after backoff`);
          await sleep(10_000 + Math.floor(Math.random() * 10_000));
          continue;
        }
        if (lease) sender.start(); // boot failed mid-way: the outbox still holds the rows
        if (!announced) {
          const cause = (e as { cause?: { code?: string; message?: string } }).cause;
          log(`${lane} lane idle (${String((e as Error).message ?? e)}${cause ? `: ${cause.code ?? cause.message ?? ""}` : ""}) — retrying every ${ACQUIRE_RETRY_MS / 1000}s`);
          announced = true;
        }
        await sleep(lane === "work" ? ACQUIRE_RETRY_MS : 5_000);
      }
    }
  }

  void renewLoop();
  void sweepLoop();
  void laneLoop("work");
  void laneLoop("control");
  log(`started for machine ${machineId} against ${relayUrl}`);

  return {
    async stop() {
      stopped = true;
      lease = null;
      sender.stop();
      setRecordSink(null);
      // A publish still coalescing owes the relay a card PATCH only: the
      // count itself committed with the drop, and any card publication for
      // the session — this lane's or the next one's — re-asserts it.
      for (const [, t] of budgetPublish) clearTimeout(t);
      budgetPublish.clear();
    },
    // The tunnel executor BORROWS this lease rather than acquiring its own
    // (a second acquirer on the same machineId evicts the first).
    currentLease: () => (lease ? { leaseId: lease.leaseId, leaseToken: lease.leaseToken } : null),
    relayTurns: () => [...activeTurns.entries()].map(([turnId, t]) => ({
      turnId, localSessionId: t.localId, commandId: t.commandId,
      state: t.adoptionPending ? "adoption_pending" as const : t.started ? "running" as const : "dispatching" as const,
      ...(t.adoptionPending ? { since: t.adoptionPending.since, attempts: t.adoptionPending.attempts, lastError: t.adoptionPending.lastError } : {}),
    })),
    spawnSpecSealed: () => spawnSpecKey !== null,
    eventBudgetDrops: () => [...budgetDropped.entries()].map(([v2SessionId, st]) => ({
      v2SessionId, localSessionId: st.localId, since: st.since, dropped: st.dropped,
    })),
  };
}
