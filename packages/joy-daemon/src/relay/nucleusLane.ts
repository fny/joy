// The daemon's v2 nucleus lane: the client side of the relay's durable queue
// and the daemon's ONLY app-facing message plane. It acquires a machine
// lease, long-polls the work and control lanes, and bridges claimed v2 turns
// onto the SAME session machinery every other transport uses:
//
//   spawn_session offer → registry.create() → bind (spawnCommandId)
//   prompt offer        → session.enqueue() → busy()/chat-log observation
//                          → output facts (per assistant message) → terminal
//   cancel offer        → session.abort() → terminal(cancelled)
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
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "../domain/atomicWrite";
import { join } from "node:path";
import { registerV2CardPublisher, unregisterV2CardPublisher, registerV2SessionId, cardStateFor, publishV2Card } from "./v2Card";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../domain/registry";
import type { AgentSession } from "../domain/agentSession";
import { joyRelayAccessKey, joyStateDir } from "../paths";
import { setRecordSink, setOutboundPersistDegraded, type WireRecord } from "./relay";
import { OutboundSpool, type SpooledOutput, type SpooledTerminal } from "./outboundSpool";
import { writeAttachmentToCwd } from "../domain/attachments";
import { cloneForSpawn } from "../domain/operations";

const RENEW_MS = 8_000;           // lease TTL is 20s server-side
const CLAIM_WAIT_MS = 25_000;
const POLL_MS = 500;              // chat-log / busy() observation cadence
const IDLE_DEBOUNCE_POLLS = 3;    // busy() must stay false this long = turn over
const DISPATCH_TIMEOUT_MS = 60_000;
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
  log?: (line: string) => void;
}

export interface NucleusLaneHandle { stop(): Promise<void>; currentLease(): { leaseId: string; leaseToken: string } | null }

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
    try {
      const raw = Buffer.from(ciphertext.slice(5), "base64");
      const n = tweetnacl.secretbox.nonceLength;
      const pt = tweetnacl.secretbox.open(new Uint8Array(raw.subarray(n)), new Uint8Array(raw.subarray(0, n)), key);
      if (!pt) return null;
      return JSON.parse(Buffer.from(pt).toString("utf8"));
    } catch { return null; }
  }
  if (key) return null; // plaintext offered to a SEALED session: unauthenticated — refuse (#579)
  try { return JSON.parse(ciphertext); } catch { return null; }
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

export function decodeSpawnSpec(ciphertext: string | null | undefined): SpawnSpec | null {
  if (!ciphertext) return null;
  try {
    const p = JSON.parse(ciphertext);
    if (p && p.t === "spawn") return p;
    return null;
  } catch { return null; }
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
  let stopped = false;
  let lease: Lease | null = null;
  // Chat-log ids are an in-memory counter reset on every boot — a bare
  // chat:<id> runtimeEventId from THIS boot could replay-collide with one
  // from the last boot and get silently dropped by the relay. Scope them.
  const bootNonce = randomUUID().slice(0, 8);
  // spawnCommandId → localSessionId, persisted across the create→bind gap so
  // a crash between the two never spawns a SECOND real agent for the same
  // command (the re-offer finds the intent record and only re-binds).
  const spawnIntentPath = join(joyStateDir(), "v2-spawns.json");
  const readSpawnIntents = (): Record<string, string> => {
    try { return JSON.parse(readFileSync(spawnIntentPath, "utf8")); } catch { return {}; }
  };
  const writeSpawnIntent = (commandId: string, localId: string): void => {
    const m = readSpawnIntents();
    m[commandId] = localId;
    // Atomic replace via the shared primitive (fsync'd temp + rename): a crash
    // mid-write used to truncate the whole map and lose every other command's
    // mapping (Astra on 2f803b14, #75); Wave B routes the remaining hand-rolled
    // tmp+rename through domain/atomicWrite.
    writeFileAtomic(spawnIntentPath, JSON.stringify(m, null, 2));
  };
  // v2 sessionId → local session id, rebuilt from the relay on start and
  // extended by every bind we perform.
  const bound = new Map<string, string>();
  // v2 sessionId → content key. Generated at spawn, persisted in the window
  // record, reloaded on restart. Absent entry = plaintext (legacy) session.
  const sessionKeys = new Map<string, Uint8Array>();
  // turnIds currently executing here (guards the received→submitted re-offer
  // window) and turnIds a control-lane cancel has targeted.
  const inFlight = new Set<string>();
  const cancelRequested = new Set<string>();
  // Executing turns: what cancel/cleanup needs to stop LOCAL work too —
  // terminalizing the relay alone leaves a queued prompt to fire later.
  const activeTurns = new Map<string, { localId: string; queuedId: string | null; lease: Lease }>();
  // local session id → v2 session id (the inverse of `bound`), for the
  // record sink, which only knows the local id.
  const boundByLocal = new Map<string, string>();
  // Cancels already acted on, keyed by target turn. The relay re-offers an
  // outstanding cancel command every control claim until the turn
  // terminalizes — without this dedup the SAME abort fired dozens of times
  // (observed: 61×, including once after terminalization) and the control
  // loop hot-spun on the standing offer.
  const handledCancels = new Set<string>();
  /** Turn → earliest time to retry a cancel whose interrupt failed. The relay
   *  re-offers a received cancel instantly while the turn is nonterminal, so
   *  a busy adapter refusing the interrupt drove claim/receipt/abort at their
   *  completion rate with no pause (Astra on e9e4ff52, #8). */
  const cancelRetryAt = new Map<string, number>();
  const CANCEL_RETRY_MS = 3_000;
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
  // one (fenced to that turn's lease), else session-scoped. Posts are
  // serialized per session so the log keeps the adapter's order, and a turn
  // drains its session's chain before terminalizing so no record of the
  // turn lands after its terminal fact.
  const recordChains = new Map<string, Promise<void>>();
  const recordFailures = new Set<string>();
  // Every record and every terminal fact is written to the spool BEFORE the
  // POST and removed only on ack — a relay outage or a daemon restart no
  // longer loses output (#60, #67) or leaves a turn unterminated (#74).
  const spool = new OutboundSpool(join(joyStateDir(), "v2-outbound.json"));
  const RETRY_MAX_MS = 30_000;
  // How a failed POST is handled. Lease fencing (401 unknown/expired lease,
  // 412 stale epoch) is TRANSIENT: it says nothing about whether the relay
  // has the record, and the next lease can retry — deleting on it lost
  // acknowledged-by-nobody data (Astra's review of 6229b647). The relay's
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
  const isPermanent = (e: unknown): boolean => fateOf(e) === "permanent";
  // Entries a live loop is retrying right now — replay leaves them alone.
  const posting = new Set<string>();
  // Sessions whose relay event budget is exhausted: logged once, outputs dropped.
  const budgetExhausted = new Set<string>();
  // Latched when a spool save fails; cleared only when a resave puts every
  // in-memory entry on disk (or they all ack and the empty spool saves). A
  // small backlog is not evidence of persistence (Astra, 478a7a83).
  let persistFailed = false;
  /** Degraded = persistence failed OR some session's backlog is over the cap. */
  const publishSpoolHealth = () => setOutboundPersistDegraded(persistFailed || spool.overflowing());
  // Every save writes the WHOLE array, so one successful add() is a flush
  // that covers every in-memory entry — that, or the sweep's resave, ends
  // the latch. A small backlog never does.
  const noteAdd = (r: { saved: boolean; overflow: boolean }) => { persistFailed = !r.saved; publishSpoolHealth(); };
  // True from lease acquire until replaySpool has scheduled everything the
  // spool held, in order. While set, flushUnbound only stamps ids (replay is
  // the single ordered scheduler at boot).
  let replayPending = false;
  /** POST one spooled output until the relay acks it. Turn-scoped while its
   *  turn is still ours; otherwise (turn ended, daemon restarted) session-
   *  scoped — the chat is per session, the content still lands. */
  /** Put an output on its session's ordered chain — once. Ownership is taken
   *  HERE, at schedule time, so a replay pass never queues a second sender
   *  for an entry that is waiting behind a blocked head (Astra, a07c43e2). */
  function scheduleOutput(entry: SpooledOutput): void {
    if (posting.has(entry.id)) return;
    posting.add(entry.id);
    const chain = (recordChains.get(entry.localId) ?? Promise.resolve()).then(() => postOutput(entry));
    recordChains.set(entry.localId, chain);
  }
  async function postOutput(entry: SpooledOutput): Promise<void> {
    try {
      let delay = 1_000;
      while (!stopped) {
        const v2 = entry.v2SessionId;
        if (!v2) return; // still unbound: flushed by spool.bind() later
        if (budgetExhausted.has(v2)) { spool.remove(entry.id); return; }
        const l = lease;
        if (!l) { await sleep(delay); delay = Math.min(RETRY_MAX_MS, delay * 2); continue; }
        // The key the record was spooled under rides the entry (#582): a
        // session killed and un-recorded before its output drained used to
        // lose its key, and "no key" selected PLAINTEXT — a previously sealed
        // conversation went to the relay in the clear on replay. The live key
        // wins when the session still has one; the spooled copy covers a
        // session whose window record is gone; a sealed entry with neither
        // is dropped, never downgraded.
        const key = sessionKeys.get(v2) ?? spooledKey(entry);
        const sealedOnly = entry.sealed === true
          // An entry from before the flag existed cannot say — on a daemon
          // that seals, an unknown is treated as sealed rather than leaked.
          || (entry.sealed === undefined && !!opts.accountContentPublicKey);
        if (!key && sealedOnly) {
          log(`record ${entry.runtimeEventId} for ${entry.localId}: sealed session's content key is unavailable — dropped rather than sent in plaintext (#582)`);
          spool.remove(entry.id);
          return;
        }
        const ciphertext = encodeRecord(entry.wire, key);
        const turn = entry.turnId && activeTurns.get(entry.turnId);
        try {
          if (turn) {
            try {
              await api("POST", `/daemon/turns/${entry.turnId}/facts`, { type: "output", ciphertext, runtimeEventId: entry.runtimeEventId }, l);
            } catch (e) {
              if (fateOf(e) !== "permanent") throw e;
              // The turn will not take it (terminal, fenced out): keep the content on the session.
              await api("POST", `/daemon/sessions/${v2}/facts`, { type: "output", ciphertext, runtimeEventId: entry.runtimeEventId }, l);
            }
          } else {
            await api("POST", `/daemon/sessions/${v2}/facts`, { type: "output", ciphertext, runtimeEventId: entry.runtimeEventId }, l);
          }
          spool.remove(entry.id);
          recordFailures.delete(entry.localId);
          return;
        } catch (e) {
          const fate = fateOf(e);
          if (fate === "budget") {
            if (!budgetExhausted.has(v2)) {
              budgetExhausted.add(v2);
              log(`${entry.localId}: relay event budget exhausted for v2 ${v2.slice(0, 8)} — further output for this session is dropped; the session needs a fresh card`);
            }
            spool.remove(entry.id);
            return;
          }
          if (fate === "permanent") {
            log(`record ${entry.runtimeEventId} for ${entry.localId} rejected for good: ${(e as Error).message} — dropped`);
            spool.remove(entry.id);
            return;
          }
          if (!recordFailures.has(entry.localId)) {
            recordFailures.add(entry.localId);
            log(`record forward failed for ${entry.localId}: ${(e as Error).message} — retrying with backoff (muted until the next success)`);
          }
          await sleep(delay); delay = Math.min(RETRY_MAX_MS, delay * 2);
        }
      }
    } finally {
      posting.delete(entry.id);
    }
  }
  /** The content key a spooled entry was sealed under, if it carries one. */
  const spooledKey = (entry: SpooledOutput): Uint8Array | undefined => {
    if (!entry.key) return undefined;
    try { return new Uint8Array(Buffer.from(entry.key, "base64")); } catch { return undefined; }
  };
  /** The sealing identity for a relay session, as the spool persists it (#582). */
  const sealFor = (v2SessionId: string): { sealed: boolean; key?: string } => {
    const k = sessionKeys.get(v2SessionId);
    return k ? { sealed: true, key: Buffer.from(k).toString("base64") } : { sealed: false };
  };
  function forwardRecord(localId: string, wire: WireRecord, recLocalId?: string): void {
    // The app's user row IS the relay's turn.queued event; lane-dispatched
    // prompts enqueue with mirrorToRelay:false, and the claude tailer only
    // mirrors what the app did NOT send — so a user record here is a prompt
    // typed at the terminal, which the app has no other way to see.
    const v2SessionId = boundByLocal.get(localId) ?? null;
    const turnEntry = [...activeTurns.entries()].find(([, v]) => v.localId === localId);
    const entry: SpooledOutput = {
      kind: "output", id: randomUUID(), localId, v2SessionId, turnId: turnEntry?.[0] ?? null, wire,
      runtimeEventId: recLocalId ? `rec:${recLocalId}` : `rec:${bootNonce}:${randomUUID()}`, at: Date.now(),
      // Bound: persist the key beside the record now (#582). Unbound: the
      // bind stamps it (spool.bind) once the session has a row and a key.
      ...(v2SessionId ? sealFor(v2SessionId) : {}),
    };
    // Durable before anything else — adapters checkpoint on return. When the
    // disk refuses, say so: RelaySession.outboundPersistDegraded holds the
    // transcript checkpoint until the spool persists again.
    noteAdd(spool.add(entry));
    if (!v2SessionId) return; // not bound yet: spool.bind() flushes it when the card exists
    if (replayPending) return; // boot: replaySpool schedules everything in spool order, this included
    scheduleOutput(entry);
  }
  /** Records spooled before a session was bound: give them their relay id
   *  and send them (in order) now that a card exists. */
  function flushUnbound(localId: string, v2SessionId: string): void {
    const hits = spool.bind(localId, v2SessionId, sealFor(v2SessionId));
    if (!hits.length) return;
    // At boot the spool may also hold OLDER, already-bound records for this
    // session: replaySpool schedules everything in spool order, so only
    // stamp here and let it do the sending.
    if (replayPending) return;
    log(`${localId}: flushing ${hits.length} record(s) spooled before bind`);
    for (const e of hits) scheduleOutput(e);
  }
  const drainRecords = (localId: string): Promise<void> => recordChains.get(localId) ?? Promise.resolve();
  setRecordSink(forwardRecord);

  /** A turn terminal, durable until acked. The intent is persisted FIRST,
   *  then the session's outputs are drained (the terminal must land after
   *  them), then it is posted with the CURRENT lease — retried on fencing
   *  and transport failures, dropped only when the relay says the turn will
   *  not take it. After a minute the retry moves to the background; a
   *  restart hands the saved outcome to replaySpool. */
  async function postTerminal(turnId: string, localId: string, body: Record<string, unknown>, leaseRef: Lease): Promise<void> {
    const entry: SpooledTerminal = { kind: "terminal", id: randomUUID(), v2SessionId: boundByLocal.get(localId) ?? "", localId, turnId, body, at: Date.now() };
    noteAdd(spool.add(entry));
    posting.add(entry.id);
    let handedOff = false;
    try {
      await drainRecords(localId);
      const attempt = async (): Promise<boolean> => {
        const l = lease ?? leaseRef;
        try {
          await api("POST", `/daemon/turns/${turnId}/facts`, body, l);
          spool.remove(entry.id);
          return true;
        } catch (e) {
          if (fateOf(e) === "permanent") {
            // Already terminal / turn gone: the relay has an answer for this turn.
            log(`terminal for turn ${turnId.slice(0, 8)} rejected (${(e as Error).message}) — dropped`);
            spool.remove(entry.id);
            return true;
          }
          return false;
        }
      };
      const deadline = Date.now() + 60_000;
      let delay = 1_000;
      while (!stopped) {
        if (await attempt()) return;
        if (Date.now() > deadline) break;
        await sleep(delay); delay = Math.min(RETRY_MAX_MS, delay * 2);
      }
      log(`terminal for turn ${turnId.slice(0, 8)} still unacked after 60s — retrying in the background`);
      handedOff = true; // the background worker owns the entry from here
      void (async () => {
        try {
          while (!stopped) {
            await sleep(delay); delay = Math.min(RETRY_MAX_MS, delay * 2);
            if (!lease) continue;
            if (await attempt()) return;
          }
        } finally { posting.delete(entry.id); }
      })();
    } finally {
      if (!handedOff) posting.delete(entry.id);
    }
  }

  /** A saved terminal from a previous lease/daemon: resolve the turn with
   *  the RECORDED outcome via reconcile. Returns true when settled. */
  async function reconcileSaved(e: SpooledTerminal): Promise<boolean> {
    const l = lease;
    if (!l) return false;
    try {
      await api("POST", `/daemon/turns/${e.turnId}/reconcile`, {
        resolution: "terminal", terminalState: e.body.terminalState ?? "interrupted",
        meta: { ...(e.body.meta as object ?? {}), replayed: true },
      }, l);
      spool.remove(e.id);
      return true;
    } catch (err) {
      const fate = fateOf(err);
      if (fate === "permanent" && (err as { status?: number }).status !== 409) { spool.remove(e.id); return true; }
      // 409 turn_not_orphaned: the relay has not orphaned the old epoch's
      // turn yet (≤20s) — the next sweep tick tries again.
      return false;
    }
  }

  /** Everything the spool holds that no live loop owns, scheduled in spool
   *  order per session: outputs onto the session's chain, a terminal chained
   *  AFTER that session's outputs (so completion never lands before the
   *  answer). Runs after every (re)acquire and on every sweep tick, so a
   *  deferred reconcile or a lease-fenced retry is picked up again. */
  async function replaySpool(): Promise<void> {
    try { await replaySpoolInner(); } finally { replayPending = false; }
  }
  async function replaySpoolInner(): Promise<void> {
    const entries = spool.all().filter((e) => !posting.has(e.id));
    if (entries.length && replayPending) log(`replaying ${entries.length} spooled record(s)`);
    for (const e of entries) {
      if (stopped) return;
      if (e.kind === "output") {
        if (!e.v2SessionId) {
          const v2 = boundByLocal.get(e.localId);
          if (v2) { e.v2SessionId = v2; Object.assign(e, sealFor(v2)); }
          else if (!registry.get(e.localId) || Date.now() - e.at > 24 * 3_600_000) {
            // Nothing will ever bind this: the session is gone (a probe, a
            // killed-before-bind scratch session) or it has waited a day.
            spool.remove(e.id);
            continue;
          } else continue;
        }
        if (!activeTurns.has(e.turnId ?? "")) e.turnId = null;
        scheduleOutput(e);
        continue;
      }
      // A saved terminal: after its session's pending outputs. Entries from
      // before localId was recorded fall back to the binding map.
      if (!e.localId) e.localId = bound.get(e.v2SessionId);
      posting.add(e.id);
      const key = e.localId ?? e.turnId;
      const chain = (recordChains.get(key) ?? Promise.resolve()).then(async () => {
        try { await reconcileSaved(e); } finally { posting.delete(e.id); }
      });
      recordChains.set(key, chain);
    }
  }

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
    await reconcileOrphanedTurns(r.sessions ?? []);
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
  async function reconcileOrphanedTurns(
    rows: Array<{ sessionId: string; daemonId: string; localSessionId?: string | null }>,
  ): Promise<void> {
    const l = lease;
    if (!l) return;
    for (const s of rows) {
      if (s.daemonId !== machineId || !s.localSessionId) continue;
      if (!registry.get(s.localSessionId)) continue; // dead session — reconcileOrphans archives it
      try {
        const st = await api("GET", `/sessions/${s.sessionId}`);
        const ex = st?.execution as { state?: string; turnId?: string } | undefined;
        if (ex?.state !== "orphaned" || !ex.turnId) continue;
        if (spool.hasTerminalFor(ex.turnId)) {
          // We KNOW how this turn ended — the terminal just never landed.
          // replaySpool resolves it with the recorded outcome; a generic
          // "interrupted" here would win the relay's first-terminal rule.
          void replaySpool();
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
    for (const s of rows) {
      if (s.daemonId !== machineId || !s.localSessionId) continue;
      if (s.state !== "active" && s.state !== "starting") continue;
      if (registry.get(s.localSessionId)) continue; // live (or ended-but-known: its own publisher tells the truth)
      const rec = registry.listRecords().find((x) => x.id === s.localSessionId);
      const key = sessionKeys.get(s.sessionId) ?? null;
      const card = {
        path: rec?.launchCwd ?? "",
        host: hostname(),
        machineId,
        joy__state: "archived",
        joy__sessionId: s.localSessionId,
        v2: { sessionId: s.sessionId, relay: relayUrl, localSessionId: s.localSessionId },
      };
      try {
        await api("PATCH", `/daemon/sessions/${s.sessionId}`, { encryptedMetadata: sealCard(card, key), state: "archived" }, l);
        log(`reconcile: archived orphan ${s.sessionId.slice(0, 8)} (local ${s.localSessionId} has no runtime)`);
      } catch (e) {
        log(`reconcile: archive ${s.sessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
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
        await api("PATCH", `/daemon/sessions/${v2SessionId}`, {
          encryptedMetadata: sealCard(metadata, key),
          state: cardStateFor(metadata.joy__state),
        }, l);
      } catch (e) {
        log(`card publish ${v2SessionId.slice(0, 8)} failed: ${e instanceof Error ? e.message : e}`);
        throw e;
      }
    });
    const current = registry.get(localId)?.cardMetadata?.();
    if (current) void publishV2Card(localId, current);
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

  async function handleSpawn(offer: WorkOffer, leaseRef: Lease): Promise<void> {
    await api("POST", `/daemon/deliveries/${offer.deliveryId}/received`, {}, leaseRef);
    // A client retry re-queues the spawn WITH createDir on the offer — clear
    // the abandon mark so we attempt it again. Without createDir it stays
    // abandoned (avoids re-spinning a still-missing directory).
    if (offer.createDir) abandonedSpawns.delete(offer.commandId);
    if (abandonedSpawns.has(offer.commandId)) return;
    const spec = decodeSpawnSpec(offer.ciphertext);
    if (!spec?.cwd) {
      // Undecodable/incomplete spec: leave the command for a human — binding
      // a session we cannot actually run would strand prompts harder.
      log(`spawn ${offer.sessionId.slice(0, 8)}: no usable spawnSpec (need {t:'spawn',cwd,...}) — skipped`);
      return;
    }
    let localId: string | undefined;
    try {
      // Idempotency across the create→bind gap: a prior attempt that crashed
      // after create left an intent record — re-bind that session instead of
      // spawning a second real agent for the same command.
      const prior = readSpawnIntents()[offer.commandId];
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
        try { await cloneForSpawn(gitUrl, spec.cwd); } catch (e) { cloneError = e instanceof Error ? e.message : String(e); }
        if (cloneError !== null) {
          abandonedSpawns.add(offer.commandId);
          try {
            await api("POST", `/daemon/sessions/${offer.sessionId}/spawn-failed`, { reason: `clone_failed:${cloneError}` }, leaseRef);
          } catch (e2) { log(`spawn ${offer.sessionId.slice(0, 8)}: failed to report clone_failed: ${String(e2)}`); }
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
          cwd: spec.cwd,
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
        abandonedSpawns.add(offer.commandId);
        try {
          await api("POST", `/daemon/sessions/${offer.sessionId}/spawn-failed`, { reason: `already_bound:${elsewhere}` }, leaseRef);
        } catch (e2) { log(`spawn ${offer.sessionId.slice(0, 8)}: failed to report already_bound: ${String(e2)}`); }
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
          // 28208445, #151).
          abandonedSpawns.add(offer.commandId);
          log(`spawn ${offer.sessionId.slice(0, 8)}: relay session gone at bind (${st}) — killing local ${session.id}`);
          try { await session.forceKill(); } catch (e2) { log(`spawn ${offer.sessionId.slice(0, 8)}: kill of orphaned ${session.id} failed: ${String(e2)}`); }
          return;
        }
        throw e;
      }
      bound.set(offer.sessionId, session.id); boundByLocal.set(session.id, offer.sessionId);
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
        abandonedSpawns.add(offer.commandId);
        try {
          await api("POST", `/daemon/sessions/${offer.sessionId}/spawn-failed`, { reason: `dir_missing:${spec.cwd}` }, leaseRef);
        } catch (e2) { log(`spawn ${offer.sessionId.slice(0, 8)}: failed to report dir_missing: ${String(e2)}`); }
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
        await api("POST", `/daemon/turns/${turnId}/submitted`, {}, leaseRef);
        await postTerminal(turnId, sess.id, {
          type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(),
          meta: { reason },
        }, leaseRef);
        log(`turn ${turnId.slice(0, 8)}: ${reason.replace(/_/g, " ")} → failed`);
        return;
      }
      await api("POST", `/daemon/turns/${turnId}/submitted`, {}, leaseRef);

      // Materialize the cited attachments into the session's cwd BEFORE the
      // prompt goes in: each becomes a bare `./name` line the agent resolves
      // against its cwd. A prompt about a screenshot that lost the screenshot
      // is worse than an honest failure, so any fetch/open/write miss fails
      // the turn (submitted → failed) instead of dispatching a truncated ask.
      let text = prompt.text;
      const writtenAttachments: string[] = [];
      if (prompt.attachments.length) {
        // The relay validated + pinned the OUTER id list (the offer); the
        // sealed citations are what the sender meant. Only their intersection
        // is trusted: a citation the relay never saw for this session is
        // refused rather than fetched on account scope alone.
        // Register the turn NOW so a control-lane cancel that lands during
        // the download has something to mark; the prompt is checked against
        // cancelRequested again right before it is enqueued (#77).
        activeTurns.set(turnId, { localId: sess.id, queuedId: null, lease: leaseRef });
        const authorized = new Set((offer.attachments ?? []).map((x) => x.id));
        const paths: string[] = [];
        const written: string[] = writtenAttachments;
        // Half-materialized prompts are worse than none — a failed turn must
        // not leave files the agent never heard about in the cwd.
        const fail = async (reason: string, a: PromptAttachment) => {
          for (const abs of written) { try { unlinkSync(abs); } catch { /* already gone */ } }
          await postTerminal(turnId, sess.id, {
            type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(), meta: { reason, attachmentId: a.id },
          }, leaseRef);
          log(`turn ${turnId.slice(0, 8)}: ${reason} (${a.name}) → failed`);
        };
        for (const a of prompt.attachments) {
          if (!authorized.has(a.id)) return fail("attachment_not_authorized", a);
          let path: string | null = null;
          let reason = "attachment_fetch_failed";
          try {
            const sealed = await fetchAttachment(a.id);
            const bytes = openAttachmentBytes(sealed, sessionKeys.get(offer.sessionId));
            if (bytes) { reason = "attachment_write_failed"; path = writeAttachmentToCwd(sess.cwd, bytes, a.name); }
            else reason = "attachment_open_failed";
          } catch (e) {
            log(`turn ${turnId.slice(0, 8)}: attachment ${a.id.slice(0, 8)} (${a.name}): ${(e as Error).message}`);
          }
          if (!path) return fail(reason, a);
          paths.push(path);
          written.push(join(sess.cwd, path.slice(2)));
        }
        const uncited = [...authorized].filter((id) => !prompt.attachments.some((a) => a.id === id));
        if (uncited.length) log(`turn ${turnId.slice(0, 8)}: ${uncited.length} offered attachment(s) not cited in the sealed prompt — ignored`);
        text = `${text}\n${paths.join("\n")}`;
        log(`turn ${turnId.slice(0, 8)}: materialized ${paths.length} attachment(s) in ${sess.cwd}`);
      }

      // (declared above the attachment block so the cancel path can clean up)
      // Watermark the chat log BEFORE dispatch: everything the session's
      // agent says after this point belongs to this turn.
      const history = registry.chatHistory();
      let watermark = history.length ? Number(history[history.length - 1].id) : -1;

      if (cancelRequested.has(turnId)) {
        // Cancelled while we were preparing it (attachments): never enqueue,
        // and take back the files we materialized for it.
        for (const abs of writtenAttachments) { try { unlinkSync(abs); } catch { /* already gone */ } }
        await postTerminal(turnId, sess.id, { type: "terminal", terminalState: "cancelled", runtimeEventId: randomUUID(), meta: { reason: "cancelled_before_enqueue" } }, leaseRef);
        log(`turn ${turnId.slice(0, 8)}: cancelled before enqueue → cancelled`);
        return;
      }
      const queued = sess.enqueue(text, { source: "rpc", visible: false, mirrorToRelay: false });
      activeTurns.set(turnId, { localId: sess.id, queuedId: queued?.id ?? null, lease: leaseRef });
      if (cancelRequested.has(turnId) && queued?.id) { try { sess.cancelQueued(queued.id); } catch { /* stub adapters */ } }
      // Every later line for this turn names the session AND the local queue
      // item, so "turn X completed" can be tied to the message it carried.
      const tag = `turn ${turnId.slice(0, 8)} [${sess.id}/${queued?.id ?? "?"}]`;

      // A joy-owned slash command (/title, /steer, …) is executed by enqueue and
      // never queued, so there is no dispatch to wait for. Close the turn now:
      // parked in the gates below it would sit until some UNRELATED activity
      // flipped busy(), then hold the session's relay execution slot with every
      // later message stuck behind it (live 2026-09-03).
      if (queued?.handled === "command") {
        try {
          await api("POST", `/daemon/turns/${turnId}/start`, { runtimeEventId: randomUUID() }, leaseRef);
        } catch (e) {
          if ((e as { status?: number }).status === 409) {
            // The relay refuses the start (cancelled): a /joy-prompt may have
            // enqueued its reinjection already — pluck it, then say cancelled.
            const rein = (queued as { reinjectionId?: string }).reinjectionId;
            let plucked = false;
            if (rein) { try { plucked = sess.cancelQueued(rein); } catch { /* stub adapters */ } }
            // A reinjection that was already admitted (cancelQueued found
            // nothing) is interrupted like an ordinary rejected start. A command
            // that enqueued no work (/title) aborts nothing — that interrupted an
            // unrelated terminal-started turn (Astra on 995abbf6).
            if (rein && !plucked) { try { await sess.abort(); } catch { /* pane teardown */ } }
            for (const abs of writtenAttachments) { try { unlinkSync(abs); } catch { /* already gone */ } }
            await postTerminal(turnId, sess.id, { type: "terminal", terminalState: "cancelled", runtimeEventId: randomUUID(), meta: { reason: "start_rejected", detail: (e as Error).message.slice(0, 200) } }, leaseRef);
            log(`${tag}: /start refused for a handled command → cancelled`);
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

      /** Terminalize the relay AND stop the local work — a failed turn whose
       *  prompt stays queued locally would execute later anyway (and again
       *  on a human retry). cancelQueued is claude-precise; the other
       *  adapters stub it (their inbound can't be plucked), so abort() is
       *  the fallback hammer when the turn already started. */
      const failTurn = async (reason: string, { abortLocal = false } = {}) => {
        try { if (queued?.id) sess.cancelQueued(queued.id); } catch { /* stub adapters */ }
        if (abortLocal) { try { await sess.abort(); } catch { /* pane teardown */ } }
        await postTerminal(turnId, sess.id, {
          type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(),
          meta: { reason },
        }, leaseRef);
        log(`${tag}: ${reason} → failed`);
      };
      // Chat rows carry session_id = the LOCAL id for codex/opencode/pi but
      // the CLAUDE TRANSCRIPT UUID for claude (and that uuid can change on
      // resume) — match either, reading claudeSessionId live each time.
      const isOurs = (m: { session_id?: string }) =>
        m.session_id === sess.id || (!!sess.claudeSessionId && m.session_id === sess.claudeSessionId);
      // Peek (without consuming) for assistant output past the watermark —
      // the cross-adapter "the agent is actually doing something" signal.
      const activitySince = () => registry.chatHistory().some((m) =>
        Number(m.id) > watermark && isOurs(m as { session_id?: string }) && m.role === "assistant");

      // Phase A — OUR prompt reaches the agent.
      //
      // The authoritative signal is the adapter's per-item delivery state, when
      // it has one (claude): it answers about THIS message. The old heuristic
      // asked `pendingCount === 0 || busy()`, and for claude busy() is true from
      // ENQUEUE onward — so A passed instantly on our own staging, B passed on
      // the same flag, and C then terminalized `completed` the moment the
      // session went idle. A prompt that never got typed was reported to the
      // relay as a finished turn: silent loss, seen live 2026-09-03 (`turn
      // 7a017583 completed` with no `[dispatch] typed` line for its item).
      //
      // Adapters with no per-item tracking (codex/opencode/pi) keep the
      // heuristic — pendingCount is the one queue signal all of them fill.
      const qid = queued?.id ?? null;
      const itemState = (): string =>
        (qid && sess.queueItemState ? sess.queueItemState(qid) : "unknown");
      const tracked = itemState() !== "unknown";
      // A message legitimately queued behind a long turn must NOT time out, so
      // the tracked path waits as long as the turn itself may run.
      const dispatchDeadline = Date.now() + (tracked ? TURN_CAP_MS : DISPATCH_TIMEOUT_MS);
      let deliveryProven = false;
      for (;;) {
        relive();
        const qs = sess.queueState() as { pendingCount: number; paused: boolean };
        if (qs.paused) return failTurn("queue_paused");
        if (tracked) {
          const st = itemState();
          if (st === "delivered") { deliveryProven = true; break; }
          if (st === "unknown") {
            // The item left the queue without recording an outcome — a confirm
            // path we don't know about. NEVER hang on that: fall back to the
            // flag heuristic for this turn. (Waiting instead parked turns in
            // `dispatching` for the full cap and wedged the session — my own
            // regression, caught live 2026-09-03 within the hour.)
            log(`${tag}: delivery state lost — falling back to activity signals`);
            break;
          }
          if (st === "cancelled") {
            // Plucked locally (a cancel, an abort, a session teardown). The
            // prompt will never run — say so instead of reporting `completed`.
            await postTerminal(turnId, sess.id, {
              type: "terminal", terminalState: "cancelled", runtimeEventId: randomUUID(),
              meta: { reason: "prompt_cancelled_locally" },
            }, leaseRef);
            log(`${tag}: prompt cancelled before delivery → cancelled`);
            return;
          }
          if (st === "failed") {
            // The harness answered and refused the prompt (opencode 4xx/5xx):
            // terminal, and it must not be retried on unrelated intake (#79).
            await postTerminal(turnId, sess.id, {
              type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(),
              meta: { reason: "prompt_rejected_by_agent" },
            }, leaseRef);
            log(`${tag}: prompt rejected by the agent → failed`);
            return;
          }
        } else if (qs.pendingCount === 0 || sess.busy()) break;
        if (Date.now() > dispatchDeadline) return failTurn("dispatch_timeout");
        await sleep(POLL_MS);
      }

      // Phase B — evidence the turn is RUNNING before we tell the relay so.
      // A proven delivery IS that evidence: the message was typed, submitted and
      // echo-confirmed. Otherwise fall back to the flags — codex/opencode/pi flip
      // busy() (= thinking) asynchronously after the harness accepts the submit,
      // and without this gate a turn read "completed" in one debounce window
      // before the agent ever started.
      if (deliveryProven) {
        log(`${tag}: started (delivery confirmed)`);
      } else {
        const startDeadline = Date.now() + 180_000;
        for (;;) {
          relive();
          if (cancelRequested.has(turnId)) {
            // Restarted before the agent ever started on it: the prompt died
            // with the process. Say cancelled now, not no_agent_activity in
            // three minutes.
            await postTerminal(turnId, sess.id, {
              type: "terminal", terminalState: "cancelled", runtimeEventId: randomUUID(),
              meta: { reason: "restarted_before_start" },
            }, leaseRef);
            log(`${tag}: restarted before start → cancelled`);
            return;
          }
          if (sess.busy()) { log(`${tag}: started (busy)`); break; }
          if (activitySince()) { log(`${tag}: started (agent output)`); break; }
          if ((sess.queueState() as { paused: boolean }).paused) return failTurn("queue_paused");
          if (Date.now() > startDeadline) return failTurn("no_agent_activity");
          await sleep(POLL_MS);
        }
      }
      try {
        await api("POST", `/daemon/turns/${turnId}/start`, { runtimeEventId: randomUUID() }, leaseRef);
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st === 409) {
          // The relay refuses the start — typically turn_cancelled from a
          // cancellation that beat the control offer here. The prompt is
          // already admitted locally: pluck it and abort, then say cancelled
          // (Astra, #77).
          if (queued?.id) { try { sess.cancelQueued(queued.id); } catch { /* stub adapters */ } }
          try { await sess.abort(); } catch { /* pane teardown */ }
          for (const abs of writtenAttachments) { try { unlinkSync(abs); } catch { /* already gone */ } } // the prompt never runs: its files go too
          await postTerminal(turnId, sess.id, { type: "terminal", terminalState: "cancelled", runtimeEventId: randomUUID(), meta: { reason: "start_rejected", detail: (e as Error).message.slice(0, 200) } }, leaseRef);
          log(`${tag}: /start refused (${(e as Error).message}) → admitted prompt plucked + aborted → cancelled`);
          return;
        }
        throw e;
      }

      // Observe until the session has been idle for IDLE_DEBOUNCE_POLLS
      // consecutive polls. The turn's CONTENT no longer comes from here: the
      // adapter records (text, tool calls, turn lifecycle + usage) flow
      // through forwardRecord as they are produced; the chat log is only the
      // cross-adapter activity signal that keeps the watermark honest.
      const capDeadline = Date.now() + TURN_CAP_MS;
      let idlePolls = 0;
      for (;;) {
        relive();
        for (const m of registry.chatHistory()) {
          const id = Number(m.id);
          if (id > watermark) watermark = id;
        }
        if ((sess.queueState() as { paused: boolean }).paused) return failTurn("queue_paused");
        if (cancelRequested.has(turnId) && sess !== session) break; // replaced under us: over
        if (sess.busy()) idlePolls = 0;
        else if (++idlePolls >= IDLE_DEBOUNCE_POLLS) break;
        if (Date.now() > capDeadline) {
          // Stop the REAL agent too — reporting interrupted while the agent
          // keeps burning would be a lie with a bill attached.
          try { await sess.abort(); } catch { /* pane teardown */ }
                    await postTerminal(turnId, sess.id, {
            type: "terminal", terminalState: "interrupted", runtimeEventId: randomUUID(),
            meta: { reason: "turn_cap" },
          }, leaseRef);
          log(`${tag}: 30min cap → interrupted (agent aborted)`);
          return;
        }
        await sleep(POLL_MS);
      }

      const terminalState = cancelRequested.has(turnId) ? "cancelled" : "completed";
            await postTerminal(turnId, sess.id, {
        type: "terminal", terminalState, runtimeEventId: randomUUID(),
      }, leaseRef);
      log(`${tag} ${terminalState}`);
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
      cancelRequested.delete(turnId);
      activeTurns.delete(turnId);
      handledCancels.delete(turnId);
      cancelRetryAt.delete(turnId);
    }
  }

  /** Returns true when this offer was NEW (acted on), false for a re-offer
   *  of a cancel we already handled — the caller uses that to back off. */
  async function handleCancel(offer: ControlOffer, leaseRef: Lease): Promise<boolean> {
    if (handledCancels.has(offer.targetTurnId)) return false;
    const retryAt = cancelRetryAt.get(offer.targetTurnId);
    if (retryAt !== undefined) { if (Date.now() < retryAt) return false; cancelRetryAt.delete(offer.targetTurnId); }
    // Mark handled only AFTER the receipt ack lands — a transient /received
    // failure must leave the offer eligible for the relay's re-offer, not
    // suppressed until turn cleanup. (Offers arrive sequentially per claim,
    // so the check-then-mark gap cannot double-fire within one loop.)
    await api("POST", `/daemon/deliveries/${offer.deliveryId}/received`, {}, leaseRef);
    handledCancels.add(offer.targetTurnId);
    cancelRequested.add(offer.targetTurnId);
    const session = localSession(offer.sessionId);
    if (session) {
      // Pluck the still-queued prompt FIRST (claude-precise; stubbed
      // elsewhere) so an early cancel can't leave it to fire later, then
      // abort whatever is actually running.
      const ctx = activeTurns.get(offer.targetTurnId);
      if (ctx?.queuedId) { try { session.cancelQueued(ctx.queuedId); } catch { /* stub adapters */ } }
      let aborted = false;
      let why = "";
      try { const r = await session.abort(); aborted = r.ok !== false; why = r.error ?? ""; } catch (e) { why = e instanceof Error ? e.message : String(e); }
      if (aborted) {
        log(`cancel ${offer.targetTurnId.slice(0, 8)}: queued plucked + abort sent`);
      } else {
        // The interrupt did not land: leave this cancel UNHANDLED so the relay's
        // re-offer retries it instead of the log claiming success (#8).
        handledCancels.delete(offer.targetTurnId);
        cancelRetryAt.set(offer.targetTurnId, Date.now() + CANCEL_RETRY_MS);
        log(`cancel ${offer.targetTurnId.slice(0, 8)}: abort failed (${why}) — retrying in ${CANCEL_RETRY_MS / 1000}s`);
        return false; // not new work: let the loop pause instead of spinning on the re-offer
      }
    }
    // The running turn loop observes busy() falling and terminalizes with
    // 'cancelled' (cancelRequested). A cancel for a turn we are NOT running
    // (daemon restarted mid-turn) is acked and resolves when the turn is
    // reconciled or retried.
    return true;
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
  async function announceLocalSession(session: AgentSession): Promise<void> {
    if (!lease || boundByLocal.has(session.id) || announcing.has(session.id)) return;
    announcing.add(session.id);
    try {
      const rec = registry.listRecords().find((r) => r.id === session.id);
      if (rec?.v2SessionId) {
        // Bound before (a recovered record): just re-establish the maps.
        bound.set(rec.v2SessionId, session.id); boundByLocal.set(session.id, rec.v2SessionId);
        if (rec.v2SessionKey) sessionKeys.set(rec.v2SessionId, new Uint8Array(Buffer.from(rec.v2SessionKey, "base64")));
        wireCardPublisher(session.id, rec.v2SessionId);
        return;
      }
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
        mode: "announce_existing", creationIntentId: `announce:${session.id}`, daemonId: machineId,
        localSessionId: session.id, sessionKeyEnvelope: envelope,
      }), 15_000) as { sessionId?: string };
      const v2 = r?.sessionId;
      if (!v2) throw new Error("announce returned no sessionId");
      if (key) sessionKeys.set(v2, key);
      registry.saveRecord(session.id, { v2SessionId: v2, ...(key ? { v2SessionKey: Buffer.from(key).toString("base64") } : {}) });
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
    const spawned = new Set(Object.values(readSpawnIntents()));
    for (const s of registry.list()) {
      if (s.status !== "active" && s.status !== "starting") continue;
      if (boundByLocal.has(s.id) || spawning.has(s.id) || spawned.has(s.id)) continue;
      await announceLocalSession(s);
    }
  }

  // A session being restarted in place: its running relay turn(s) must end
  // as cancelled, not "completed" (the old object's busy() drops to false).
  // Turns whose queue item moves to the replacement (`keep`) stay alive —
  // the turn loop re-resolves the session object by local id each poll.
  (registry as { setTurnCanceller?: (fn: (localId: string, keep: ReadonlySet<string>) => void) => void }).setTurnCanceller?.((localId, keep) => {
    for (const [turnId, t] of activeTurns) {
      if (t.localId !== localId) continue;
      if (t.queuedId && keep.has(t.queuedId)) continue;
      cancelRequested.add(turnId);
    }
  });
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
          if (inFlight.has(turnId) || activeTurns.has(turnId) || spool.hasTerminalFor(turnId)) continue;
          seen.add(turnId);
          const n = (noWorkerSeen.get(turnId) ?? 0) + 1;
          noWorkerSeen.set(turnId, n);
          if (n < 2 || !lease) continue;
          // Re-check after the await: a claim may have started it meanwhile.
          if (inFlight.has(turnId) || activeTurns.has(turnId)) { noWorkerSeen.delete(turnId); continue; }
          try {
            await api("POST", `/daemon/turns/${turnId}/reconcile`, { resolution: "terminal", terminalState: "interrupted", meta: { reason: "no_local_worker" } }, lease);
            log(`released turn ${turnId.slice(0, 8)} on ${row.sessionId.slice(0, 8)}: executing on the relay, no worker here → interrupted`);
          } catch (e) {
            log(`release of turn ${turnId.slice(0, 8)} failed: ${(e as Error).message}`);
          }
          noWorkerSeen.delete(turnId);
        }
        for (const k of [...noWorkerSeen.keys()]) if (!seen.has(k)) noWorkerSeen.delete(k);
        // Saved records nobody is retrying (a deferred reconcile, a fenced retry).
        if (spool.size) void replaySpool();
        // Persistence health: a failed save stays latched until a resave puts
        // every pending entry on disk; the overflow half clears when every
        // session's backlog is back under the cap.
        if (persistFailed && spool.resave()) { persistFailed = false; log("spool persistence restored"); }
        publishSpoolHealth();
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
          replayPending = true;
          await refreshBindings();
          void replaySpool();
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
            // spool without bound (Astra, 478a7a83).
            const gatedLocal = bound.get(offer.sessionId);
            if (gatedLocal && spool.pendingOutputs(gatedLocal) > OutboundSpool.MAX_OUTPUTS_PER_SESSION) {
              if (!notedSkips.has(offer.turnId!)) { notedSkips.add(offer.turnId!); log(`turn ${offer.turnId!.slice(0, 8)}: ${gatedLocal} has ${spool.pendingOutputs(gatedLocal)} undelivered outputs — dispatch paused until they drain`); }
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
          log(`${lane} lane: lease lost (${String((e as Error).message ?? e)}) — re-acquiring after backoff`);
          await sleep(10_000 + Math.floor(Math.random() * 10_000));
          continue;
        }
        if (replayPending && lease) void replaySpool(); // boot failed mid-way: schedule what the spool holds
        if (!announced) {
          log(`${lane} lane idle (${String((e as Error).message ?? e)}) — retrying every ${ACQUIRE_RETRY_MS / 1000}s`);
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
      setRecordSink(null);
    },
    // The tunnel executor BORROWS this lease rather than acquiring its own
    // (a second acquirer on the same machineId evicts the first).
    currentLease: () => (lease ? { leaseId: lease.leaseId, leaseToken: lease.leaseToken } : null),
  };
}
