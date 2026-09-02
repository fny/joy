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
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { registerV2CardPublisher, unregisterV2CardPublisher, cardStateFor, publishV2Card } from "./v2Card";
import { DirectoryCreationApprovalRequired, type SessionRegistry } from "../domain/registry";
import type { AgentSession } from "../domain/agentSession";
import { joyRelayAccessKey, joyStateDir } from "../paths";
import { setRecordSink, type WireRecord } from "./relay";
import { writeAttachmentToCwd } from "../domain/attachments";

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
// Legacy/test format: plain JSON {v:1,t:'plain',text}. decode accepts both so
// pre-encryption sessions keep working; encode seals whenever a key exists.
export function decodeContent(ciphertext: string | null | undefined, key?: Uint8Array | null): string | null {
  if (!ciphertext) return null;
  if (ciphertext.startsWith("v2e1:")) {
    if (!key) return null; // sealed content without the session key — refuse
    try {
      const raw = Buffer.from(ciphertext.slice(5), "base64");
      const n = tweetnacl.secretbox.nonceLength;
      const pt = tweetnacl.secretbox.open(new Uint8Array(raw.subarray(n)), new Uint8Array(raw.subarray(0, n)), key);
      if (!pt) return null;
      const p = JSON.parse(Buffer.from(pt).toString("utf8"));
      return typeof p.text === "string" ? p.text : null;
    } catch { return null; }
  }
  try {
    const p = JSON.parse(ciphertext);
    if (p && typeof p.text === "string") return p.text;
    return null;
  } catch { return null; }
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
  let p: any;
  if (ciphertext.startsWith("v2e1:")) {
    if (!key) return null;
    try {
      const raw = Buffer.from(ciphertext.slice(5), "base64");
      const n = tweetnacl.secretbox.nonceLength;
      const pt = tweetnacl.secretbox.open(new Uint8Array(raw.subarray(n)), new Uint8Array(raw.subarray(0, n)), key);
      if (!pt) return null;
      p = JSON.parse(Buffer.from(pt).toString("utf8"));
    } catch { return null; }
  } else {
    try { p = JSON.parse(ciphertext); } catch { return null; }
  }
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
  let p: any;
  if (ciphertext.startsWith("v2e1:")) {
    if (!key) return null;
    try {
      const raw = Buffer.from(ciphertext.slice(5), "base64");
      const n = tweetnacl.secretbox.nonceLength;
      const pt = tweetnacl.secretbox.open(new Uint8Array(raw.subarray(n)), new Uint8Array(raw.subarray(0, n)), key);
      if (!pt) return null;
      p = JSON.parse(Buffer.from(pt).toString("utf8"));
    } catch { return null; }
  } else {
    try { p = JSON.parse(ciphertext); } catch { return null; }
  }
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
    mkdirSync(joyStateDir(), { recursive: true });
    writeFileSync(spawnIntentPath, JSON.stringify(m, null, 2));
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
  // Turns we can't run (no local session / undecodable) — logged once, not
  // per re-offer, so a stranded turn doesn't spam the journal every claim.
  const notedSkips = new Set<string>();
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
    });
    const json = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const err = new Error(`${method} ${path} -> ${res.status} ${json?.error ?? ""}`);
      (err as Error & { status?: number }).status = res.status;
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
  function forwardRecord(localId: string, wire: WireRecord, recLocalId?: string): void {
    // The app's user row IS the relay's turn.queued event; lane-dispatched
    // prompts enqueue with mirrorToRelay:false, and the claude tailer only
    // mirrors what the app did NOT send — so a user record here is a prompt
    // typed at the terminal, which the app has no other way to see.
    const v2SessionId = boundByLocal.get(localId);
    if (!v2SessionId) return; // not a v2-bound session (nothing to attach to)
    const turnEntry = [...activeTurns.entries()].find(([, v]) => v.localId === localId);
    const runtimeEventId = recLocalId ? `rec:${recLocalId}` : `rec:${bootNonce}:${randomUUID()}`;
    const ciphertext = encodeRecord(wire, sessionKeys.get(v2SessionId));
    const post = async () => {
      try {
        if (turnEntry) {
          await api("POST", `/daemon/turns/${turnEntry[0]}/facts`, { type: "output", ciphertext, runtimeEventId }, turnEntry[1].lease);
        } else {
          if (!lease) return; // between leases: nothing durable to fence to
          await api("POST", `/daemon/sessions/${v2SessionId}/facts`, { type: "output", ciphertext, runtimeEventId }, lease);
        }
        recordFailures.delete(localId);
      } catch (e) {
        if (!recordFailures.has(localId)) {
          recordFailures.add(localId);
          log(`record forward failed for ${localId}: ${(e as Error).message} (muted until the next success)`);
        }
      }
    };
    const chain = (recordChains.get(localId) ?? Promise.resolve()).then(post);
    recordChains.set(localId, chain);
  }
  const drainRecords = (localId: string): Promise<void> => recordChains.get(localId) ?? Promise.resolve();
  setRecordSink(forwardRecord);

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
    for (const s of r.sessions ?? []) {
      if (s.daemonId !== machineId || !s.localSessionId) continue;
      const sess = registry.get(s.localSessionId);
      if (!sess) continue;
      const rec = registry.listRecords().find((x) => x.id === s.localSessionId);
      const envelope = rec?.v2SessionKey && opts.accountContentPublicKey
        ? sealSessionKey(new Uint8Array(Buffer.from(rec.v2SessionKey, "base64")), opts.accountContentPublicKey)
        : "v2:plaintext";
      sess.setV2Link?.({ sessionId: s.sessionId, relay: relayUrl, keyEnvelope: envelope });
      wireCardPublisher(s.localSessionId, s.sessionId);
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
    try {
      // Idempotency across the create→bind gap: a prior attempt that crashed
      // after create left an intent record — re-bind that session instead of
      // spawning a second real agent for the same command.
      const prior = readSpawnIntents()[offer.commandId];
      let session = prior ? registry.get(prior) : undefined;
      if (session && session.status === "ended") session = undefined;
      if (!session) {
        session = await registry.create({
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
        writeSpawnIntent(offer.commandId, session.id);
      }
      // Content sealing: with the account's content public key on hand,
      // mint the session's symmetric key, persist it beside the window
      // record, and envelope it to the account in the bind. Without the
      // key (legacy pairing) the session stays on plaintext envelopes.
      let envelope = "v2:plaintext";
      if (opts.accountContentPublicKey) {
        const key = new Uint8Array(randomBytes(32));
        sessionKeys.set(offer.sessionId, key);
        registry.saveRecord(session.id, { v2SessionId: offer.sessionId, v2SessionKey: Buffer.from(key).toString("base64") });
        envelope = sealSessionKey(key, opts.accountContentPublicKey);
      } else {
        registry.saveRecord(session.id, { v2SessionId: offer.sessionId });
      }
      await api("POST", `/daemon/sessions/${offer.sessionId}/bind`, {
        spawnCommandId: offer.commandId,
        localSessionId: session.id,
        sessionKeyEnvelope: envelope,
      }, leaseRef);
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
    }
  }

  async function runTurn(offer: WorkOffer, leaseRef: Lease): Promise<void> {
    const turnId = offer.turnId!;
    if (inFlight.has(turnId)) return;
    inFlight.add(turnId);
    try {
      await api("POST", `/daemon/deliveries/${offer.deliveryId}/received`, {}, leaseRef);
      let session = localSession(offer.sessionId);
      if (!session) {
        // The binding map may be stale (daemon restarted since bind) —
        // self-heal once from the relay before declaring the session missing.
        try { await refreshBindings(); } catch { /* transient */ }
        session = localSession(offer.sessionId);
      }
      if (!session || session.status === "ended") {
        // No local runtime for this session (deleted window, dead daemon
        // generation). Leave the turn queued — honest visibility beats a
        // fabricated failure. The lane logs once; the human decides.
        if (!notedSkips.has(turnId)) {
          notedSkips.add(turnId);
          log(`turn ${turnId.slice(0, 8)}: no local session for v2 ${offer.sessionId.slice(0, 8)} — left queued`);
        }
        return;
      }
      const prompt = decodePrompt(offer.ciphertext, sessionKeys.get(offer.sessionId));
      if (prompt === null) {
        if (!notedSkips.has(turnId)) {
          notedSkips.add(turnId);
          log(`turn ${turnId.slice(0, 8)}: undecodable prompt — left queued`);
        }
        return;
      }
      await api("POST", `/daemon/turns/${turnId}/submitted`, {}, leaseRef);

      // Materialize the cited attachments into the session's cwd BEFORE the
      // prompt goes in: each becomes a bare `./name` line the agent resolves
      // against its cwd. A prompt about a screenshot that lost the screenshot
      // is worse than an honest failure, so any fetch/open/write miss fails
      // the turn (submitted → failed) instead of dispatching a truncated ask.
      let text = prompt.text;
      if (prompt.attachments.length) {
        // The relay validated + pinned the OUTER id list (the offer); the
        // sealed citations are what the sender meant. Only their intersection
        // is trusted: a citation the relay never saw for this session is
        // refused rather than fetched on account scope alone.
        const authorized = new Set((offer.attachments ?? []).map((x) => x.id));
        const paths: string[] = [];
        const written: string[] = [];
        // Half-materialized prompts are worse than none — a failed turn must
        // not leave files the agent never heard about in the cwd.
        const fail = async (reason: string, a: PromptAttachment) => {
          for (const abs of written) { try { unlinkSync(abs); } catch { /* already gone */ } }
          await api("POST", `/daemon/turns/${turnId}/facts`, {
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
            if (bytes) { reason = "attachment_write_failed"; path = writeAttachmentToCwd(session.cwd, bytes, a.name); }
            else reason = "attachment_open_failed";
          } catch (e) {
            log(`turn ${turnId.slice(0, 8)}: attachment ${a.id.slice(0, 8)} (${a.name}): ${(e as Error).message}`);
          }
          if (!path) return fail(reason, a);
          paths.push(path);
          written.push(join(session.cwd, path.slice(2)));
        }
        const uncited = [...authorized].filter((id) => !prompt.attachments.some((a) => a.id === id));
        if (uncited.length) log(`turn ${turnId.slice(0, 8)}: ${uncited.length} offered attachment(s) not cited in the sealed prompt — ignored`);
        text = `${text}\n${paths.join("\n")}`;
        log(`turn ${turnId.slice(0, 8)}: materialized ${paths.length} attachment(s) in ${session.cwd}`);
      }

      // Watermark the chat log BEFORE dispatch: everything the session's
      // agent says after this point belongs to this turn.
      const history = registry.chatHistory();
      let watermark = history.length ? Number(history[history.length - 1].id) : -1;

      const queued = session.enqueue(text, { source: "rpc", visible: false, mirrorToRelay: false });
      activeTurns.set(turnId, { localId: session.id, queuedId: queued?.id ?? null, lease: leaseRef });

      /** Terminalize the relay AND stop the local work — a failed turn whose
       *  prompt stays queued locally would execute later anyway (and again
       *  on a human retry). cancelQueued is claude-precise; the other
       *  adapters stub it (their inbound can't be plucked), so abort() is
       *  the fallback hammer when the turn already started. */
      const failTurn = async (reason: string, { abortLocal = false } = {}) => {
        try { if (queued?.id) session!.cancelQueued(queued.id); } catch { /* stub adapters */ }
        if (abortLocal) { try { await session!.abort(); } catch { /* pane teardown */ } }
        await api("POST", `/daemon/turns/${turnId}/facts`, {
          type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(),
          meta: { reason },
        }, leaseRef);
        log(`turn ${turnId.slice(0, 8)}: ${reason} → failed`);
      };
      // Chat rows carry session_id = the LOCAL id for codex/opencode/pi but
      // the CLAUDE TRANSCRIPT UUID for claude (and that uuid can change on
      // resume) — match either, reading claudeSessionId live each time.
      const isOurs = (m: { session_id?: string }) =>
        m.session_id === session!.id || (!!session!.claudeSessionId && m.session_id === session!.claudeSessionId);
      // Peek (without consuming) for assistant output past the watermark —
      // the cross-adapter "the agent is actually doing something" signal.
      const activitySince = () => registry.chatHistory().some((m) =>
        Number(m.id) > watermark && isOurs(m as { session_id?: string }) && m.role === "assistant");

      // Phase A — the prompt leaves the LOCAL queue. Cross-adapter contract
      // (verified against all four implementations): pendingCount is the only
      // queue signal every adapter fills — claude counts all undelivered
      // (incl. hidden + in-flight), codex/opencode count queued inbound, pi
      // counts harness-queued. claude's busy() is true from enqueue onward
      // (queue length), so busy() short-circuits A there and phases B/C carry
      // the real waiting; the paused check therefore ALSO lives in B/C.
      const dispatchDeadline = Date.now() + DISPATCH_TIMEOUT_MS;
      for (;;) {
        const qs = session.queueState() as { pendingCount: number; paused: boolean };
        if (qs.paused) return failTurn("queue_paused");
        if (qs.pendingCount === 0 || session.busy()) break;
        if (Date.now() > dispatchDeadline) return failTurn("dispatch_timeout");
        await sleep(POLL_MS);
      }

      // Phase B — evidence the turn is RUNNING before we tell the relay so.
      // codex/opencode/pi flip busy() (= thinking) asynchronously after the
      // harness accepts the submit; without this gate a turn read "completed"
      // in one debounce window before the agent ever started (the exact
      // false-instant-complete the review caught).
      const startDeadline = Date.now() + 180_000;
      for (;;) {
        if (session.busy() || activitySince()) break;
        if ((session.queueState() as { paused: boolean }).paused) return failTurn("queue_paused");
        if (Date.now() > startDeadline) return failTurn("no_agent_activity");
        await sleep(POLL_MS);
      }
      await api("POST", `/daemon/turns/${turnId}/start`, { runtimeEventId: randomUUID() }, leaseRef);

      // Observe until the session has been idle for IDLE_DEBOUNCE_POLLS
      // consecutive polls. The turn's CONTENT no longer comes from here: the
      // adapter records (text, tool calls, turn lifecycle + usage) flow
      // through forwardRecord as they are produced; the chat log is only the
      // cross-adapter activity signal that keeps the watermark honest.
      const capDeadline = Date.now() + TURN_CAP_MS;
      let idlePolls = 0;
      for (;;) {
        for (const m of registry.chatHistory()) {
          const id = Number(m.id);
          if (id > watermark) watermark = id;
        }
        if ((session.queueState() as { paused: boolean }).paused) return failTurn("queue_paused");
        if (session.busy()) idlePolls = 0;
        else if (++idlePolls >= IDLE_DEBOUNCE_POLLS) break;
        if (Date.now() > capDeadline) {
          // Stop the REAL agent too — reporting interrupted while the agent
          // keeps burning would be a lie with a bill attached.
          try { await session.abort(); } catch { /* pane teardown */ }
          await drainRecords(session.id);
          await api("POST", `/daemon/turns/${turnId}/facts`, {
            type: "terminal", terminalState: "interrupted", runtimeEventId: randomUUID(),
            meta: { reason: "turn_cap" },
          }, leaseRef);
          log(`turn ${turnId.slice(0, 8)}: 30min cap → interrupted (agent aborted)`);
          return;
        }
        await sleep(POLL_MS);
      }

      const terminalState = cancelRequested.has(turnId) ? "cancelled" : "completed";
      await drainRecords(session.id);
      await api("POST", `/daemon/turns/${turnId}/facts`, {
        type: "terminal", terminalState, runtimeEventId: randomUUID(),
      }, leaseRef);
      log(`turn ${turnId.slice(0, 8)} ${terminalState}`);
    } catch (e) {
      log(`turn ${turnId.slice(0, 8)} error: ${String(e)}`);
      // Best-effort: leave the relay a terminal instead of a forever-running
      // turn (with a live lease the sweep will never orphan it). If this post
      // also fails, lease death eventually orphans the turn — still honest.
      try {
        await api("POST", `/daemon/turns/${turnId}/facts`, {
          type: "terminal", terminalState: "failed", runtimeEventId: randomUUID(),
          meta: { reason: "lane_error", detail: String(e).slice(0, 300) },
        }, leaseRef);
      } catch { /* covered by lease-expiry orphaning */ }
    } finally {
      inFlight.delete(turnId);
      cancelRequested.delete(turnId);
      activeTurns.delete(turnId);
      handledCancels.delete(turnId);
    }
  }

  /** Returns true when this offer was NEW (acted on), false for a re-offer
   *  of a cancel we already handled — the caller uses that to back off. */
  async function handleCancel(offer: ControlOffer, leaseRef: Lease): Promise<boolean> {
    if (handledCancels.has(offer.targetTurnId)) return false;
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
      try { await session.abort(); } catch { /* pane may be mid-teardown */ }
      log(`cancel ${offer.targetTurnId.slice(0, 8)}: queued plucked + abort sent`);
    }
    // The running turn loop observes busy() falling and terminalizes with
    // 'cancelled' (cancelRequested). A cancel for a turn we are NOT running
    // (daemon restarted mid-turn) is acked and resolves when the turn is
    // reconciled or retried.
    return true;
  }

  const isLeaseDeath = (e: unknown) =>
    /lease_unknown|lease_expired|lease_epoch_stale/.test(String(e));

  async function renewLoop(): Promise<void> {
    while (!stopped) {
      await sleep(RENEW_MS);
      if (!lease) continue;
      try {
        const res = await fetch(`${relayUrl}/joy/v2/daemon/leases/${lease.leaseId}`, {
          method: "PUT",
          headers: { ...baseHeaders(), "x-joy-lease-token": lease.leaseToken },
        });
        if (!res.ok) throw new Error(`renew -> ${res.status}`);
      } catch {
        lease = null; // acquire loop below re-establishes
      }
    }
  }

  async function laneLoop(lane: "work" | "control"): Promise<void> {
    let announced = false;
    while (!stopped) {
      try {
        if (!lease) {
          if (lane === "control") { await sleep(1_000); continue; } // work loop owns acquire
          await acquire();
          await refreshBindings();
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
          else if (offer.kind === "prompt") { void runTurn(offer, leaseRef); anyNew = true; }
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
        if (!announced) {
          log(`${lane} lane idle (${String((e as Error).message ?? e)}) — retrying every ${ACQUIRE_RETRY_MS / 1000}s`);
          announced = true;
        }
        await sleep(lane === "work" ? ACQUIRE_RETRY_MS : 5_000);
      }
    }
  }

  void renewLoop();
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
