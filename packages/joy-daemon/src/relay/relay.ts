/**
 * Relay integration for joy-daemon — the account plane over `/joy/v2` HTTP.
 *
 * Three concerns live here:
 *   - RelayClient: the machine row (sealed metadata + daemonState with CAS
 *     versions), push notifications, and credential loading. Plain fetch —
 *     the relay has no socket surface, and machine presence is derived
 *     server-side from the nucleus lane's lease.
 *   - RelaySession: the per-session CARD — the metadata object the app renders
 *     (title, lifecycle state, queue, banners…). Held locally, merged
 *     serially, and published to the relay through the v2 card seam
 *     (./v2Card → nucleusLane) on every change.
 *   - Wire encoders: the transcript-mirror record shapes the agent
 *     normalizers still produce (see `send`).
 *
 * Self-contained — no deps on joy-daemon internals beyond paths + the card
 * seam. External deps: tweetnacl.
 */
import { loadWindowRecord } from "../domain/windowRecord";
import { setTimeout as sleep } from "timers/promises";
import { execSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, platform, cpus, freemem, totalmem, loadavg, homedir } from 'node:os';
import { joyRelayCredsDir, joyRelayUrl, joyRelayAccessKey } from '../paths';
import { publishV2Card, v2SessionIdFor } from './v2Card';
import tweetnacl from 'tweetnacl';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface Credentials {
  token: string;
  serverUrl: string;
  machineId: string;
  /** Account content public key + this machine's data key (the only pairing
   *  shape joy has ever written; pair-relay.mjs / `joy auth`). */
  encryption: { type: 'dataKey'; publicKey: Uint8Array; machineKey: Uint8Array };
}

/** A transcript-mirror record (user text / agent session event). Produced by
 *  the agent normalizers and handed to RelaySession.send; see there. */
export interface WireRecord {
  role: 'user' | 'agent' | 'session';
  content: { type: string; [k: string]: unknown };
  meta?: { sentFrom?: string; [k: string]: unknown };
}

// ── Crypto ─────────────────────────────────────────────────────────────────────

function b64encode(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64');
}

function b64decode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}

function randomBytesU8(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n));
}

function encryptDataKey(data: unknown, key: Uint8Array): Uint8Array {
  const nonce = randomBytesU8(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const pt = new TextEncoder().encode(JSON.stringify(data));
  const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  const bundle = new Uint8Array(1 + 12 + enc.length + 16);
  bundle.set([0], 0);
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(enc), 13);
  bundle.set(new Uint8Array(tag), 13 + enc.length);
  return bundle;
}

function decryptDataKey(buf: Uint8Array, key: Uint8Array): unknown | null {
  if (buf.length < 1 + 12 + 16 || buf[0] !== 0) return null;
  const nonce = buf.slice(1, 13);
  const tag = buf.slice(buf.length - 16);
  const ct = buf.slice(13, buf.length - 16);
  try {
    const dec = createDecipheriv('aes-256-gcm', key, nonce);
    dec.setAuthTag(tag);
    return JSON.parse(new TextDecoder().decode(Buffer.concat([dec.update(ct), dec.final()])));
  } catch { return null; }
}

/** Machine-blob sealing (metadata + daemonState). The app opens it with the
 *  machine key it unwraps from `dataEncryptionKey`. */
/** Exported for tests (machine metadata round-trips). */
export function encryptWire(key: Uint8Array, data: unknown): Uint8Array {
  return encryptDataKey(data, key);
}

export function decryptWire(key: Uint8Array, buf: Uint8Array): unknown | null {
  return decryptDataKey(buf, key);
}

function libsodiumEncryptForPublicKey(data: Uint8Array, recipientPublicKey: Uint8Array): Uint8Array {
  const ephemeral = tweetnacl.box.keyPair();
  const nonce = randomBytesU8(tweetnacl.box.nonceLength);
  const ct = tweetnacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);
  const out = new Uint8Array(ephemeral.publicKey.length + nonce.length + ct.length);
  out.set(ephemeral.publicKey, 0);
  out.set(nonce, ephemeral.publicKey.length);
  out.set(ct, ephemeral.publicKey.length + nonce.length);
  return out;
}

// ── Credentials ────────────────────────────────────────────────────────────────

export function loadCredentials(): Credentials | null {
  // Relay selection is shared with path scoping (paths.joyRelayUrl):
  // JOY_RELAY_URL (alias or URL) / ~/.joy/relay.json override the default.
  // Every relay reads its own pairing from ~/.joy/relays/<host_port>/, so
  // moving the default never relocates a pairing.
  const serverUrl = joyRelayUrl();
  const credsDir = joyRelayCredsDir(serverUrl);

  const accessKeyPath = join(credsDir, 'access.key');
  if (!existsSync(accessKeyPath)) return null;

  try {
    const ak = JSON.parse(readFileSync(accessKeyPath, 'utf8')) as {
      token?: string;
      encryption?: { publicKey?: string; machineKey?: string; secret?: string };
    };
    if (!ak.token) return null;

    let machineId: string | undefined;
    try {
      const s = JSON.parse(readFileSync(join(credsDir, 'settings.json'), 'utf8')) as { machineId?: string };
      if (s.machineId) machineId = s.machineId;
    } catch {}
    // A random fallback would give this daemon a new machine identity on
    // every restart (orphaning its sessions in the app) — say so loudly.
    if (!machineId) {
      process.stderr.write('[relay] WARNING: machineId missing from settings.json — this daemon will appear as a NEW machine on every restart. Re-run `joy auth` to repair the pairing.\n');
      machineId = crypto.randomUUID();
    }

    if (!ak.encryption?.publicKey) return null;
    const encryption: Credentials['encryption'] = {
      type: 'dataKey',
      publicKey: b64decode(ak.encryption.publicKey),
      machineKey: ak.encryption.machineKey ? b64decode(ak.encryption.machineKey) : new Uint8Array(),
    };

    return { token: ak.token, serverUrl, machineId, encryption };
  } catch { return null; }
}

// ── Relay HTTP client (account plane) ─────────────────────────────────────────

const DAEMON_STATE_INTERVAL_MS = 20_000;

export class RelayClient {
  readonly serverUrl: string;
  readonly creds: Credentials;
  private daemonStateTimer: ReturnType<typeof setInterval> | null = null;
  // Server-side daemonState version (CAS) for PATCH /machines/:id; seeded from
  // getOrCreateMachine, re-synced from each reply. Plus the previous cpu-tick
  // snapshot so we can report CPU% as a busy-delta between heartbeats.
  private daemonStateVersion = 0;
  private prevCpuSample: { idle: number; total: number } | null = null;
  // Log the ownership conflict once, not every 20s.
  private ownedElsewhereLogged = false;

  constructor(creds: Credentials) {
    this.creds = creds;
    this.serverUrl = creds.serverUrl;
  }

  /** Start the daemonState heartbeat (host cpu/ram/disk the app shows on the
   *  machine header). First beat immediately, then every 20s. Presence itself
   *  is NOT ours: the relay derives active/activeAt from the nucleus lane's
   *  lease. */
  start(): void {
    if (this.daemonStateTimer) return;
    void this.pushDaemonState();
    this.daemonStateTimer = setInterval(() => void this.pushDaemonState(), DAEMON_STATE_INTERVAL_MS);
  }

  close(): void {
    if (this.daemonStateTimer) { clearInterval(this.daemonStateTimer); this.daemonStateTimer = null; }
  }

  private url(path: string): string {
    return `${this.creds.serverUrl.replace(/\/$/, '')}/joy/v2${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.creds.token}`, 'Content-Type': 'application/json' };
    const relayKey = joyRelayAccessKey();
    if (relayKey) h['X-Joy-Relay-Key'] = relayKey;
    return h;
  }

  /** The machine data key — what getOrCreateMachine published as `dataEncryptionKey`. */
  private machineKey(): Uint8Array {
    return this.creds.encryption.machineKey;
  }

  /** CPU busy % since the last sample (delta of idle vs total ticks across all
   *  cores). The first call has no previous sample, so it falls back to the
   *  1-min load average scaled by core count. */
  private sampleCpuPercent(): number {
    const list = cpus();
    let idle = 0, total = 0;
    for (const c of list) { idle += c.times.idle; for (const t of Object.values(c.times)) total += t; }
    const prev = this.prevCpuSample;
    this.prevCpuSample = { idle, total };
    if (!prev) return Math.max(0, Math.min(100, Math.round((loadavg()[0] / Math.max(1, list.length)) * 100)));
    const di = idle - prev.idle, dt = total - prev.total;
    if (dt <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)));
  }

  /**
   * Reclaimable-aware available memory. os.freemem() reports only TRULY free
   * pages — on macOS that excludes inactive/purgeable/file-cache the OS holds
   * but frees on demand, so `1 - free/total` read ~99% "used" while Activity
   * Monitor showed ~46% (2026-07-05); Linux freemem() ignores cache/buffers
   * the same way. Use MemAvailable (Linux) / vm_stat reclaimable pages (macOS),
   * falling back to freemem() on anything unexpected. Best-effort + cached 5s
   * so the heartbeat never blocks on vm_stat.
   */
  #availMemCache: { bytes: number; at: number } | null = null;
  private availableMemBytes(): number {
    const now = Date.now();
    if (this.#availMemCache && now - this.#availMemCache.at < 5000) return this.#availMemCache.bytes;
    let bytes = freemem();
    try {
      if (platform() === 'linux') {
        const m = /MemAvailable:\s+(\d+)\s+kB/.exec(readFileSync('/proc/meminfo', 'utf8'));
        if (m) bytes = Number(m[1]) * 1024;
      } else if (platform() === 'darwin') {
        const out = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
        const pageSize = Number(/page size of (\d+) bytes/.exec(out)?.[1] ?? 4096);
        const pages = (label: string) => Number(new RegExp(label + ':\\s+(\\d+)\\.').exec(out)?.[1] ?? 0);
        // Match Activity Monitor's "Memory Used" = active + wired + compressed;
        // available = total - that. freemem()'s "free pages only" ignored the
        // large inactive/purgeable/cached pools macOS reclaims on demand, so it
        // read ~99% used. Verified against boite's live vm_stat (2026-07-05).
        const used = (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * pageSize;
        if (used > 0) bytes = Math.max(0, totalmem() - used);
      }
    } catch { /* keep freemem() fallback */ }
    this.#availMemCache = { bytes, at: now };
    return bytes;
  }

  /** The sealed daemonState blob: host CPU%/RAM% + detail for the machine page. */
  private sealedDaemonState(): string {
    const cpu = this.sampleCpuPercent();
    const memTotal = totalmem();
    const memFree = this.availableMemBytes(); // reclaimable-aware (see helper)
    const ram = Math.max(0, Math.min(100, Math.round((1 - memFree / memTotal) * 100)));
    const list = cpus();
    // Disk for the home filesystem (best-effort — statfs can fail on odd mounts).
    let diskFree = 0, diskTotal = 0;
    try {
      const s = statfsSync(homedir());
      diskFree = Number(s.bavail) * Number(s.bsize);
      diskTotal = Number(s.blocks) * Number(s.bsize);
    } catch { /* leave 0 — app shows cpu/ram regardless */ }
    const key = this.machineKey();
    return b64encode(encryptWire(key, {
      cpu, ram, time: Date.now(),
      // Detail for the machine page (bytes + cpu info); the sidebar still uses cpu/ram %.
      cpuCount: list.length,
      cpuModel: list[0]?.model,
      load: loadavg()[0],
      memFree, memTotal,
      diskFree, diskTotal,
    }));
  }

  /** Push host CPU%/RAM% into the machine's encrypted daemonState
   *  (`PATCH /machines/:id`, version-checked CAS; the app decrypts it and
   *  shows it on the machine header). Best-effort: a 404 (no session has
   *  registered the machine yet) no-ops; a version-mismatch adopts the
   *  server's current version and retries ONCE so the beat still lands. */
  async pushDaemonState(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(this.url(`/machines/${encodeURIComponent(this.creds.machineId)}`), {
          method: 'PATCH',
          headers: this.headers(),
          body: JSON.stringify({ daemonState: this.sealedDaemonState(), expectedDaemonStateVersion: this.daemonStateVersion }),
        });
        if (r.status === 404) return; // machine row not upserted yet — next beat retries
        if (!r.ok) { log(`daemonState: HTTP ${r.status}`); return; }
        const a = await r.json().catch(() => null) as { result?: string; daemonStateVersion?: number } | null;
        if (!a) return;
        // success → server bumped to expectedVersion+1; version-mismatch → adopt
        // the server's current version and retry once.
        if (typeof a.daemonStateVersion === 'number') this.daemonStateVersion = a.daemonStateVersion;
        if (a.result !== 'version-mismatch') return;
      } catch (e) {
        log(`daemonState push failed: ${e}`);
        return;
      }
    }
  }

  /** GET this machine's row: its current (decrypted) metadata, the CAS
   *  version and whether it carries a data key. `missing` = 404 (never
   *  created); null = the read FAILED (network, 5xx) — which says nothing
   *  about the row, and must never be taken as "no displayName" (#61). */
  private async fetchOwnMachine(): Promise<{ metadata: Record<string, unknown> | null; version: number; hasDataKey: boolean } | "missing" | null> {
    try {
      const res = await fetch(this.url(`/machines/${encodeURIComponent(this.creds.machineId)}`), { headers: this.headers() });
      if (res.status === 404) return "missing";
      if (!res.ok) return null;
      const body = await res.json() as { machine?: { metadata?: string; metadataVersion?: number; dataEncryptionKey?: string | null } };
      if (!body?.machine) return "missing";
      let metadata: Record<string, unknown> | null = null;
      if (body.machine.metadata) {
        try { metadata = decryptWire(this.machineKey(), b64decode(body.machine.metadata)) as Record<string, unknown> | null; } catch { metadata = null; }
      }
      return { metadata, version: Number(body.machine.metadataVersion ?? 0), hasDataKey: !!body.machine.dataEncryptionKey };
    } catch { return null; }
  }

  // Machine upserts are single-flight (#61): a boot attaches many sessions and
  // each used to race its own read+write; serializing them means every write
  // reads the row as the previous one left it.
  #machineUpsert: Promise<boolean> = Promise.resolve(true);

  /**
   * Publish the machine row's sealed metadata. The app's path picker uses
   * `machine.metadata.homeDir` to format paths as `~/foo`, and the machine
   * header shows host/version — so the daemon owns this blob and re-pushes it
   * whenever the command scan changes (commands.ts).
   *
   * App-owned fields (displayName — a rename the app made on the relay,
   * invisibly to us) are carried forward from a FRESH read and written with a
   * version-checked PATCH (#61). The old shape cached the name for 60s and
   * did a full-blob POST: a command-scan push inside that minute overwrote a
   * rename with the stale name, and once the cache expired the daemon read
   * its own overwrite back — the rename never returned. A failed GET was
   * cached as "no name" and removed an existing one the same way. Now a
   * version mismatch re-reads and retries; a failed read skips the write.
   * The full POST (which also sets dataEncryptionKey) is used only to CREATE
   * the row, or to repair one with no data key.
   */
  async getOrCreateMachine(metadata: Record<string, unknown>): Promise<boolean> {
    const run = this.#machineUpsert.then(() => this.#upsertMachine(metadata), () => this.#upsertMachine(metadata));
    this.#machineUpsert = run.then(() => true, () => true);
    return run;
  }

  async #upsertMachine(metadata: Record<string, unknown>): Promise<boolean> {
    // Always report the LIVE hostname (an OS rename shouldn't need a daemon restart).
    const base: Record<string, unknown> = { ...metadata, host: hostname() };
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const current = await this.fetchOwnMachine();
        if (current === null) {
          // Unknown state: writing now could only clobber. The next scan
          // push / heartbeat retries.
          log('getOrCreateMachine: could not read the machine row — skipping this publish (nothing overwritten)');
          return false;
        }
        const blob = { ...base };
        if (blob.displayName === undefined && current !== "missing") {
          const dn = current.metadata?.displayName;
          if (typeof dn === 'string' && dn.length > 0) blob.displayName = dn;
        }
        const encryptionKey = this.creds.encryption.machineKey;
        const sealed = b64encode(encryptWire(encryptionKey, blob));
        if (current === "missing" || !current.hasDataKey) {
          return await this.#createMachine(sealed);
        }
        const r = await fetch(this.url(`/machines/${encodeURIComponent(this.creds.machineId)}`), {
          method: 'PATCH',
          headers: this.headers(),
          body: JSON.stringify({ metadata: sealed, expectedMetadataVersion: current.version }),
        });
        if (r.status === 404) return await this.#createMachine(sealed); // vanished between read and write
        if (r.status === 403) return this.#ownedElsewhere(await r.json().catch(() => null) as { error?: string } | null);
        if (!r.ok) { log(`getOrCreateMachine: PATCH HTTP ${r.status}`); return false; }
        const a = await r.json().catch(() => null) as { result?: string; daemonStateVersion?: number } | null;
        if (a?.result === 'version-mismatch') continue; // someone (the app) wrote meanwhile: re-read, carry theirs forward
        if (typeof a?.daemonStateVersion === 'number') this.daemonStateVersion = a.daemonStateVersion;
        return true;
      }
      log('getOrCreateMachine: metadata kept changing under us — giving up this round');
      return false;
    } catch (e) {
      log(`getOrCreateMachine failed: ${e}`);
      return false;
    }
  }

  /** Full-blob upsert (`POST /machines`) — creates the row and hands the
   *  relay the enveloped machine key so it can serve it to authorized clients. */
  async #createMachine(sealedMetadata: string): Promise<boolean> {
    const encryptionKey = this.creds.encryption.machineKey;
    // Envelope [0x00][box(machineKey → account publicKey)] so the relay can
    // hand the machine key to authorized clients.
    const encryptedKey = libsodiumEncryptForPublicKey(encryptionKey, this.creds.encryption.publicKey);
    const bundle = new Uint8Array(1 + encryptedKey.length);
    bundle.set([0], 0);
    bundle.set(encryptedKey, 1);
    const r = await fetch(this.url('/machines'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ id: this.creds.machineId, metadata: sealedMetadata, dataEncryptionKey: b64encode(bundle) }),
    });
    if (r.status === 403) return this.#ownedElsewhere(await r.json().catch(() => null) as { error?: string } | null);
    if (!r.ok) { log(`getOrCreateMachine: HTTP ${r.status}`); return false; }
    // Seed the daemonState CAS version from the row so the first
    // daemonState beat lands without a version-mismatch round-trip.
    try {
      const body = await r.json() as { machine?: { daemonStateVersion?: number } };
      if (typeof body?.machine?.daemonStateVersion === 'number') this.daemonStateVersion = body.machine.daemonStateVersion;
    } catch { /* version self-syncs from the first reply */ }
    return true;
  }

  /** Another account already owns this machine id: the pairing is wrong
   *  (creds copied between accounts). Nothing here can fix it — say so once,
   *  loudly, and stop retrying quietly every push. */
  #ownedElsewhere(body: { error?: string } | null): false {
    if (!this.ownedElsewhereLogged) {
      this.ownedElsewhereLogged = true;
      log(`getOrCreateMachine: HTTP 403 ${body?.error ?? ''} — machine ${this.creds.machineId} belongs to another account; re-run \`joy auth\` to re-pair`);
    }
    return false;
  }

  /**
   * Send a push notification to all the account's devices (`POST /push`): the
   * relay holds the Expo tokens and posts to Expo per token, dropping
   * DeviceNotRegistered tokens itself. Returns how many devices were
   * targeted. Title/body are NOT end-to-end encrypted — no conversation
   * content in them.
   */
  async sendPush(title: string, body: string, data?: Record<string, unknown>): Promise<{ sent: number }> {
    const res = await fetch(this.url('/push'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ title, body: body || undefined, data: { source: 'joy-daemon', timestamp: Date.now(), ...data } }),
    });
    if (!res.ok) throw new Error(`push: HTTP ${res.status}`);
    const j = await res.json().catch(() => null) as { sent?: number } | null;
    return { sent: typeof j?.sent === 'number' ? j.sent : 0 };
  }

  /**
   * Auto-notification for a session (done/permission/question). Rides
   * sendPush with the session id + kind in `data` so the app can deep-link.
   * Fire-and-forget with one retry: the very first outbound request after a
   * daemon restart can hit a transient "fetch failed" before the network/
   * undici pool warms; a dropped notification is user-visible.
   */
  async sendSessionPushEvent(localSessionId: string, kind: 'done' | 'permission' | 'question', title: string, body: string): Promise<void> {
    // DEEP LINK IDENTITY: the app keys every session by the RELAY id, so a push
    // stamped with the daemon's local id routes to a session the app has never
    // heard of — the tap landed on "Session has been deleted" for every
    // notification (caught live 2026-09-03). Send the relay id; when the
    // session is not bound yet, send NO id at all rather than an unroutable
    // one, so the tap just opens the app instead of an error screen.
    const sessionId = v2SessionIdFor(localSessionId);
    const data: Record<string, unknown> = sessionId ? { kind, sessionId } : { kind };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const { sent } = await this.sendPush(title, body, data);
        // Success IS logged: "no push arrived" must be distinguishable between
        // never-sent, no registered device, and delivery failure.
        log(`push ${kind} sent for ${localSessionId}${sessionId ? ` → ${sessionId.slice(0, 8)}` : " (UNBOUND — no deep link)"} (${sent} device(s))`);
        return;
      } catch (e) {
        log(`push ${kind} failed for ${localSessionId} (attempt ${attempt + 1}): ${e}`);
      }
      if (attempt === 0) await sleep(1000);
    }
  }
}

// ── Relay session (per tmux session) ─────────────────────────────────────────

/** Lifecycle state the app reads from metadata to colour a session's status. */
export type JoyLifecycleState = 'running' | 'detached' | 'archived';

/** Retry banner the app renders during 500-error auto-retry. */
export interface JoyRetryInfo {
  attempt: number;   // 1-based current attempt
  total: number;     // total attempts before giving up
  nextAt: number;    // epoch ms when the next re-send fires
  status: number;    // the HTTP status that triggered the retry (e.g. 500)
}

/** Compaction banner the app renders while Claude summarizes the conversation. */
export interface JoyCompactingInfo {
  trigger: 'auto' | 'manual'; // what kicked off the compaction
  since: number;              // epoch ms when compaction started
}

/**
 * Background-task progress ("N/M completed") the app shows while
 * run_in_background bash / background agents are in flight. Tracked from the
 * transcript so "working" stays continuous across turn-end (the foreground turn
 * ends the moment a background task launches) — independent of the brittle pane
 * footer poll.
 */
export interface JoyTasksInfo {
  done: number;   // finished in this batch
  total: number;  // launched in this batch
}

/**
 * The agent's active goal (Claude's `/goal`), surfaced from the transcript's
 * `goal_status` attachments. Present while a goal is in progress (met=false);
 * cleared to null when the goal is met/cleared. The app shows a goal bar.
 */
/** Handoff bar: session.metadata.joy__handoff (see domain/handoff.ts). */
export interface JoyHandoffInfo {
  state: 'writing' | 'handed_off' | 'picked_up' | 'handed_back' | 'returned' | 'failed';
  peer?: string;
  peerLabel?: string;
  note?: string;
  error?: string;
  at: number;
}

export interface JoyGoalInfo {
  condition: string; // the goal text the user set
  since: number;     // epoch ms when this goal became active
}

/**
 * An interactive auth/login URL the agent's CLI is showing in its pane (e.g.
 * Claude Code's `/login` OAuth flow). Detected by scanning the pane for an
 * auth-shaped URL; present while the prompt is up, cleared when it's gone. The
 * app shows a login bar with the URL + a field to submit the pasted code.
 */
export interface JoyLoginInfo {
  url: string;     // the reassembled auth URL
  since: number;   // epoch ms when it was first detected
  error?: string;  // a rejection/error message shown in the box (e.g. bad code)
}

/**
 * Interactive CLI dialog occupying the pane (model picker, "Switch model?"
 * confirm, /effort slider…). These dialogs block dispatch and write nothing to
 * the transcript until answered — the app shows a "answer this in the
 * terminal" banner while one is up; cleared when the pane moves on.
 */
export interface JoyDialogInfo {
  title: string | null;   // the dialog's heading line, e.g. "Switch model?"
  options: string[];      // numbered option rows, selection marker stripped
  since: number;          // epoch ms when it was first detected
}

/** A codex approval request awaiting the user (non-yolo). The app shows an
 *  Allow/Deny bar and answers via the v2 approvals endpoint. */
export interface JoyCodexApprovalInfo {
  requestId: string;
  kind: "command" | "patch";
  title: string;          // e.g. the command line, or "Apply patch to N files"
  detail?: string;        // reason / extra context
  since: number;
  // Correlation ids (finding #6) — which thread/turn/item this approval is for.
  threadId?: string;
  turnId?: string;
  itemId?: string;
}

/** Message-queue snapshot the app reads from metadata (replaces joy-queue-list polling). */
export interface JoyQueueInfo {
  queue: { id: string; text: string; createdAt: number }[];
  inFlight: string | null;
  paused: boolean;
  /** ALL undelivered items incl. hidden app-sends — the app's "N queued". */
  pendingCount?: number;
  hidden?: { id: string; text: string; createdAt: number }[];
}

/**
 * The per-session CARD holder. `relaySessionId` is the daemon's local session
 * id (the card seam is keyed by it; the relay-side v2 session id lives in the
 * nucleus lane's binding). Metadata is local truth: the daemon is its only
 * writer, it is rebuilt on attach (summary, slash commands, model, state are
 * all re-pushed by the Session), and every merge publishes the full card via
 * the v2 seam.
 */
export class RelaySession {
  private readonly client: RelayClient;
  readonly relaySessionId: string;
  // The session card the app renders — merged serially (see mergeMetadata).
  private metadata: Record<string, unknown>;

  constructor(opts: { client: RelayClient; relaySessionId: string; metadata: Record<string, unknown> }) {
    this.client = opts.client;
    this.relaySessionId = opts.relaySessionId;
    this.metadata = { ...opts.metadata };
  }

  // Serializes metadata writes for this session (see mergeMetadata).
  private metadataChain: Promise<void> = Promise.resolve();

  /** Read-only snapshot of the current card metadata (nucleus lane bind). */
  get metadataSnapshot(): Record<string, unknown> | null { return this.metadata; }

  /**
   * Merge a patch into the session card and publish it. The single write path
   * so the title, lifecycle state, etc. don't clobber each other.
   *
   * Calls are SERIALIZED per session: concurrent patches (joy__state / joy__queue
   * / joy__retry / summary all fire near-simultaneously from the Session) each
   * read an already-updated `this.metadata`, so no field is lost.
   *
   * Resolves TRUE once the merge is applied locally — the daemon's durable
   * truth. The card publish is awaited (so a caller sequencing an archive sees
   * the PATCH land first) but its outcome does not fail the merge: a lost
   * publish costs staleness until the next merge, never state.
   */
  mergeMetadata(patch: Record<string, unknown>): Promise<boolean> {
    const run = this.metadataChain.then(() => this.doMergeMetadata(patch));
    this.metadataChain = run.then(() => undefined, () => undefined); // keep the chain alive past a failure
    return run;
  }

  /**
   * Merge ONE key unless it is redundant — judged INSIDE the serialized chain,
   * against the card as every earlier queued write leaves it (#587). The
   * helpers below used to compare against `this.metadata` before queueing:
   * with a publish pending, updateCompacting(info) then updateCompacting(null)
   * saw joy__compacting still empty at call time and dropped the clear, so
   * the banner stayed set for good; a model set to B and back to A the same
   * way stayed B. Default redundancy: both empty, or deep-equal JSON.
   */
  private mergeKey(key: string, value: unknown, redundant: (cur: unknown) => boolean = (cur) =>
    (value == null && cur == null) || (cur !== undefined && JSON.stringify(cur) === JSON.stringify(value)),
  ): Promise<boolean> {
    const run = this.metadataChain.then(() => {
      if (redundant(this.metadata[key])) return false;
      return this.doMergeMetadata({ [key]: value });
    });
    this.metadataChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Whether the LAST card publish reached the relay (false: not v2-bound
   *  yet, lane down, or the PATCH failed). */
  lastPublishOk = false;

  private async doMergeMetadata(patch: Record<string, unknown>): Promise<boolean> {
    const merged = { ...this.metadata, ...patch };
    this.metadata = merged;
    // v2 card: every metadata change re-publishes the sealed card to the
    // relay's durable plane (the app renders its session list from it).
    this.lastPublishOk = await publishV2Card(this.relaySessionId, merged);
    return true;
  }

  /**
   * Set the session's title (summary) — joy uses Claude's ai-title so the app
   * shows the real conversation title instead of "New Chat".
   */
  async updateSummary(title: string): Promise<void> {
    await this.mergeKey('summary', { text: title, updatedAt: Date.now() }, (cur) => (cur as { text?: string } | undefined)?.text === title);
  }

  /**
   * Mirror the active model the app reads (session.metadata.currentModelCode) so
   * the composer's model selector reflects the real pane state — including model
   * switches the user makes interactively in the tmux pane (/model …).
   */
  async updateModelCode(code: string): Promise<void> {
    await this.mergeKey('currentModelCode', code, (cur) => cur === code);
  }

  /**
   * Mirror the slash commands available to this session so the app's "/"
   * autocomplete (sync/suggestionCommands.ts reads metadata.slashCommands)
   * lists the real project + personal commands, not just the built-in
   * defaults. Caller passes a sorted list; skip the write when unchanged.
   */
  async updateSlashCommands(commands: string[]): Promise<void> {
    await this.mergeKey('slashCommands', commands, (cur) => {
      const current = cur as string[] | undefined;
      return !!current && current.length === commands.length && current.every((c, i) => c === commands[i]);
    });
  }

  /**
   * Set the joy lifecycle state the app reads to colour the status:
   * 'running' (alive), 'detached' (Claude died, window still around — red), or
   * 'archived' (killed/cleaned up). Drives the red detached indicator.
   */
  async updateJoyState(state: JoyLifecycleState): Promise<void> {
    await this.mergeKey('joy__state', state, (cur) => cur === state);
  }

  /**
   * Archive the session card on the relay (the v2 equivalent of the old
   * "mark inactive" call): publishes `joy__state: 'archived'`, which the card
   * publisher maps to the relay's `state: 'archived'`. Resolves TRUE when the
   * PATCH landed — killSession reports that to the app, because a killed
   * session that stays "active" in the list is the failure users notice.
   * Always publishes (no unchanged-skip) so a retry after a lost PATCH works.
   */
  async archive(): Promise<boolean> {
    await this.mergeMetadata({ joy__state: 'archived' });
    return this.lastPublishOk;
  }

  /**
   * Set (or clear, with null) the 500-error auto-retry banner the app shows
   * while a failed turn is being re-sent on a backoff schedule.
   */
  async updateRetry(info: JoyRetryInfo | null): Promise<void> {
    // Idempotent clear: skip the write when there's nothing set, so a recovered
    // session with no active retry can reconcile its banner without churn.
    await this.mergeKey('joy__retry', info);
  }

  /** Push the finishing-task N/M and the long-running-process count together in a
   *  SINGLE metadata patch, so the split can't be observed half-applied and a
   *  clear of one field can't be dropped by a still-pending set of the other.
   *  The caller (Session#reconcileBgTasks) dedups by DESIRED state, so we always
   *  write when called (no this.metadata skip that could race a pending write). */
  async updateBgTasks(tasks: JoyTasksInfo | null, agents: JoyTasksInfo | null, longRunning: number | null): Promise<void> {
    await this.mergeMetadata({ joy__tasks: tasks, joy__agents: agents, joy__longRunning: longRunning });
  }

  /** Context tokens used as of the latest turn (input + cache-read + cache-create
   *  from the transcript's cumulative usage). The app owns the window/threshold —
   *  we only report the raw count. null clears it. */
  async updateContext(tokens: number | null): Promise<void> {
    await this.mergeKey('joy__context', tokens);
  }

  async updateCompacting(info: JoyCompactingInfo | null): Promise<void> {
    await this.mergeKey('joy__compacting', info);
  }

  async updateHandoff(info: JoyHandoffInfo | null): Promise<void> {
    await this.mergeKey('joy__handoff', info);
  }

  async updateGoal(info: JoyGoalInfo | null): Promise<void> {
    await this.mergeKey('joy__goal', info);
  }

  async updateLogin(info: JoyLoginInfo | null): Promise<void> {
    await this.mergeKey('joy__login', info);
  }

  async updateCodexApproval(info: JoyCodexApprovalInfo | null): Promise<void> {
    await this.mergeKey('joy__codexApproval', info);
  }

  /** Single-flight latest-desired-value reconciler. Callers assert the desired
   *  dialog every pane poll; at most ONE metadata write is in flight, always
   *  targeting the LATEST desired value, and the state comparison runs inside
   *  the loop. Kept as a pump even though merges are local now: it still
   *  collapses a burst of 3s assertions into one write per change, and a
   *  desired value that moves mid-write gets one immediate try (teardown's
   *  clear has no next poll to retry from). */
  private desiredDialog: JoyDialogInfo | null = null;
  private dialogWriteBusy = false;
  updateDialog(info: JoyDialogInfo | null): void {
    this.desiredDialog = info;
    if (this.dialogWriteBusy) return; // in-flight write re-checks desired on completion
    void this.#pumpDialog();
  }

  async #pumpDialog(): Promise<void> {
    const eq = (a: JoyDialogInfo | null | undefined, b: JoyDialogInfo | null | undefined) =>
      a == null ? b == null
        : b != null && b.title === a.title && JSON.stringify(b.options) === JSON.stringify(a.options);
    this.dialogWriteBusy = true;
    try {
      for (;;) {
        const want = this.desiredDialog;
        if (eq(want, this.metadata?.joy__dialog as JoyDialogInfo | null | undefined)) return;
        await this.mergeMetadata({ joy__dialog: want }).catch(() => false);
        // loop: re-check a desired value that moved while writing
      }
    } finally {
      this.dialogWriteBusy = false;
    }
  }

  /**
   * Push the message-queue snapshot so the app can read it from metadata instead
   * of polling. Skips redundant writes: an empty queue when none is set, or a
   * snapshot identical to the current one (the queue broadcasts can repeat).
   */
  async updateQueue(info: JoyQueueInfo): Promise<void> {
    // "Empty" must consider the HIDDEN app-sends and the total pending count —
    // a hidden message held mid-turn with no prior joy__queue metadata hit the
    // early-return below and the app never saw its pending count (codex review
    // 2026-07-11, finding 5).
    const empty = info.queue.length === 0 && !info.inFlight && !info.paused
      && (info.pendingCount ?? 0) === 0 && (info.hidden?.length ?? 0) === 0;
    await this.mergeKey('joy__queue', info, (cur) => (empty && cur == null) || (!!cur && JSON.stringify(cur) === JSON.stringify(info)));
  }

  /** Publish the current card (attach / restart rebind). Idempotent. */
  start(): void {
    void publishV2Card(this.relaySessionId, this.metadata).then((ok) => { this.lastPublishOk = ok; });
  }

  /** Detached sessions used to downgrade their poll cadence here; with no
   *  inbound poll left this is a no-op kept for the Session call sites. */
  pausePull(): void {}

  stop(): void {}

  /**
   * Transcript-mirror sink. Every adapter normalizer (claude tailer, codex
   * app-server events, opencode SSE, pi) lands its WireRecords here — text,
   * tool-call start/end, turn start/end with usage, terminal-typed user
   * prompts. The nucleus lane registers itself as the record sink and posts
   * each one, sealed under the session's v2 content key, as a durable
   * `output` fact (turn-scoped while a relay turn runs, session-scoped
   * otherwise) — the SAME record shape the app's normalizer rendered on the
   * old socket lane, so tool cards, thinking and usage light up unchanged.
   * `localId` is the adapter's stable dedupe key (becomes the runtimeEventId).
   */
  send(wire: WireRecord, localId?: string): void {
    // A joy-message wrapper on a user row carries provenance the daemon
    // stamped (operations joy-send): surface it as structured meta so the app
    // renders "from joy:<id>" without parsing XML.
    if (wire.role === "user") {
      const from = joyMessageFrom((wire.content as { text?: unknown }).text);
      if (from) {
        const fromLabel = joyMessageFromLabel((wire.content as { text?: unknown }).text);
        wire.meta = { ...(wire.meta ?? {}), from, ...(fromLabel ? { fromLabel } : {}) };
      }
    }
    appendRecord(this.relaySessionId, wire, localId);
    recordSink?.(this.relaySessionId, wire, localId);
  }

  private receiptSink: ((r: { uuid: string; turn: string }) => void) | null = null;
  private pendingReceipts: { uuid: string; turn: string }[] = [];

  /** A transcript entry's rows have been handed to `send`. With no outbound
   *  queue there is nothing to wait for: the receipt is delivered at once
   *  (or held until the Session registers its sink on attach). */
  stampReceiptOnLastQueued(receipt: { uuid: string; turn: string }): void {
    // While the lane's spool cannot persist, a receipt would let the adapter
    // checkpoint past records that exist only in RAM (Astra, a07c43e2): hold
    // it; setOutboundPersistDegraded(false) flushes every holder.
    if (this.receiptSink && !outboundDegraded) this.receiptSink(receipt);
    else { this.pendingReceipts.push(receipt); receiptHolders.add(this); }
  }

  /** Deliver receipts held while persistence was degraded. */
  flushHeldReceipts(): void {
    if (!this.receiptSink || outboundDegraded) return;
    const pending = this.pendingReceipts.splice(0);
    for (const r of pending) this.receiptSink(r);
    receiptHolders.delete(this);
  }

  /** Session registers the receipts writer here (attachRelay). Flushes any
   *  receipts stamped before registration. */
  setReceiptSink(sink: (r: { uuid: string; turn: string }) => void): void {
    this.receiptSink = sink;
    // Same guarded path as restoration: receipts held because persistence
    // was degraded stay held until it is restored (Astra, 478a7a83).
    if (this.pendingReceipts.length) receiptHolders.add(this);
    this.flushHeldReceipts();
  }

  /** True while the lane's outbound spool cannot persist (disk full, a
   *  permissions error): the transcript checkpoint gate in
   *  Session#scheduleCheckpoint reads this and holds its checkpoint, so a
   *  record that exists only in RAM is replayed from the transcript after a
   *  crash instead of being skipped. */
  get outboundPersistDegraded(): boolean { return outboundDegraded; }

  /** Last thinking value we recorded. */
  private lastThinking = false;

  setThinking(thinking: boolean): void {
    const changed = this.lastThinking !== thinking;
    this.lastThinking = thinking;
    // Persisted on change: the app treats joy__thinking + live machine
    // presence as thinking, so a cold app start shows the real state and a
    // daemon death can't freeze a stale blue.
    if (changed) {
      void this.mergeMetadata({ joy__thinking: thinking ? { since: Date.now() } : null }).catch(() => {});
    }
  }

  /** Clear a stale persisted joy__thinking (daemon restarted while the flag
   *  was set; the fresh Session starts not-thinking so the change-gate in
   *  setThinking would never write the false). Attach-time reconcile, same
   *  pattern as the retry/compacting banners. */
  async clearThinkingMeta(): Promise<void> {
    if (this.metadata?.joy__thinking == null) return;
    await this.mergeMetadata({ joy__thinking: null });
  }

  /** Agent-authored notification (<joy-notify/> tag): free-form title + body.
   *  Title falls back to the session's host/folder so a push always identifies
   *  its source; when the agent titles it, the folder rides as a prefix. */
  notifyCustom(headline: string, detail: string | null): void {
    // Project-prefixed headline ("joy: Deploy finished") so every push reads
    // as <where>: <what> at a glance; detail (when given) is the body.
    const path = (this.metadata?.path as string | undefined)?.trim();
    const folder = path ? path.split(/[\\/]/).filter(Boolean).pop() : undefined;
    const finalTitle = folder ? `${folder}: ${headline}` : headline;
    void this.client.sendSessionPushEvent(this.relaySessionId, 'done', finalTitle, detail ?? headline);
  }

  /** Fire an auto push-notification for this session (done/permission/question).
   *  Title is the location "<host>/<folder>" (e.g. "faraz.vip/proj") so you see
   *  WHICH session at a glance; body is the reply snippet (or the per-kind reason). */
  notify(kind: 'done' | 'permission' | 'question', snippet?: string): void {
    // Push title/body travel UNSEALED through the relay and Expo. The reply
    // snippet — and the AI title, which is conversation-derived too — are
    // E2E-sealed content everywhere else; putting them in the body leaked a
    // slice of every turn to the relay operator and to Expo (#118). Bodies
    // are content-free by default (the title already says host/folder);
    // JOY_PUSH_SNIPPETS=1 opts back into the richer, less private bodies.
    const richBodies = process.env.JOY_PUSH_SNIPPETS === '1';
    const summary = richBodies ? (this.metadata?.summary as { text?: string } | undefined)?.text?.trim() : undefined;
    const body = kind === 'done' ? ((richBodies && snippet) || summary || 'Finished')
      : kind === 'permission' ? (summary ? `Permission needed · ${summary}` : 'Permission needed')
      : (summary ? `Clarification needed · ${summary}` : 'Clarification needed');
    void this.client.sendSessionPushEvent(this.relaySessionId, kind, this.#notifyLocation(), body);
  }

  /** "<host>/<folder>" — e.g. "faraz.vip/proj". Metadata only (push title/body
   *  are NOT end-to-end encrypted, so no conversation content here). */
  #notifyLocation(): string {
    const host = (this.metadata?.host as string | undefined)?.trim();
    const path = (this.metadata?.path as string | undefined)?.trim();
    const folder = path ? path.split(/[\\/]/).filter(Boolean).pop() : undefined;
    return [host, folder].filter(Boolean).join('/') || 'Joy session';
  }
}

// ── Wire encoding ──────────────────────────────────────────────────────────────

// opts.time is Claude's transcript timestamp (epoch ms) for this entry. The
// app sorts agent events by this embedded time, so stamping it from the
// transcript (not Date.now at mirror time) keeps a --resume replay in true
// chronological order. Falls back to now() when a caller omits it.
function sessionEnvelope(ev: Record<string, unknown>, opts: { turn: string; claudeUuid?: string; time?: number }): WireRecord {
  const data: Record<string, unknown> = {
    id: crypto.randomUUID(),
    time: opts.time ?? Date.now(),
    role: 'agent',
    turn: opts.turn,
    ev,
  };
  if (opts.claudeUuid) data.claudeUuid = opts.claudeUuid;
  return { role: 'session', content: { type: 'session', data }, meta: { sentFrom: 'joy' } };
}

export function encodeTurnStart(opts: { turn: string; claudeUuid?: string; time?: number }): WireRecord {
  return sessionEnvelope({ t: 'turn-start' }, opts);
}

export function encodeTextEvent(text: string, opts: { turn: string; claudeUuid?: string; time?: number }): WireRecord {
  return sessionEnvelope({ t: 'text', text }, opts);
}

export function encodeToolCallStart(opts: {
  call: string; name: string; input: unknown; turn: string; claudeUuid?: string; time?: number;
}): WireRecord {
  return sessionEnvelope({
    t: 'tool-call-start',
    call: opts.call,
    name: opts.name,
    title: opts.name,
    description: '',
    args: (opts.input && typeof opts.input === 'object') ? opts.input as Record<string, unknown> : {},
  }, opts);
}

export function encodeToolCallEnd(
  call: string,
  opts: { turn: string; claudeUuid?: string; time?: number; result?: string; isError?: boolean },
): WireRecord {
  // Carry the tool's OUTPUT and whether it failed. Until 2026-09-03 this record
  // was the call id alone, so every Claude tool card in the app showed the
  // command and that it finished — never what it printed, and a Bash call
  // that exited 1 rendered exactly like one that succeeded. The output was
  // in the very transcript entry being mirrored; it was simply dropped.
  const ev: Record<string, unknown> = { t: 'tool-call-end', call };
  if (opts.result !== undefined) ev.result = opts.result;
  if (opts.isError) ev.isError = true;
  return sessionEnvelope(ev, opts);
}

export function encodeTurnEnd(status: 'completed' | 'failed' | 'cancelled', opts: { turn: string; time?: number; usage?: unknown }): WireRecord {
  // Carry the turn's final token usage so the app can show real tokens/cost for
  // joy sessions (the raw transcript assistant entries report it as msg.usage).
  const ev: Record<string, unknown> = { t: 'turn-end', status };
  if (opts.usage) ev.usage = opts.usage;
  return sessionEnvelope(ev, opts);
}

// joyTime carries Claude's transcript timestamp so a replay burst keeps user
// and agent rows on one clock (the app orders joy user messages by it).
export function encodeUserMessage(
  text: string,
  timeMs?: number,
  opts?: { isCompactSummary?: boolean },
): WireRecord {
  const content: { type: string; [k: string]: unknown } = { type: 'text', text };
  // Post-compaction summary: Claude writes its continuation summary as a user
  // transcript entry, and mirroring it plainly drops a wall of machine text into
  // the chat as a user bubble. The flag makes the app render its collapsed
  // "Compaction summary" card instead.
  if (opts?.isCompactSummary) content.isCompactSummary = true;
  return { role: 'user', content, meta: { sentFrom: 'joy', joyTime: timeMs } };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export function initRelay(): RelayClient | null {
  const creds = loadCredentials();
  if (!creds) { log('no credentials found — relay disabled'); return null; }
  const client = new RelayClient(creds);
  client.start();
  log(`initialized → ${creds.serverUrl}`);
  return client;
}

/** Provenance attribute of a daemon-stamped <joy-message from="…"> wrapper. */
/** The daemon-stamped human label of the sender (harness · title), if any. */
export function joyMessageFromLabel(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = /^\s*<joy-message\b[^>]*\bfrom-label="([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

export function joyMessageFrom(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const m = /^\s*<joy-message\b[^>]*\bfrom="([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

// ── per-session record log (joy events / check / ask) ──────────────────────
// Every record an adapter hands to RelaySession.send, in order, with a seq —
// the machine-local twin of the relay's sealed output log. Bounded per
// session; a reader that wants more history has the relay.
export interface LoggedRecord { seq: number; at: number; record: WireRecord; localId?: string }
const RECORD_LOG_MAX = 2000;
const recordLogs = new Map<string, LoggedRecord[]>();
const recordSeqs = new Map<string, number>();
const recordSubs = new Map<string, Set<(r: LoggedRecord) => void>>();

function appendRecord(localSessionId: string, record: WireRecord, localId?: string): void {
  const seq = (recordSeqs.get(localSessionId) ?? 0) + 1;
  recordSeqs.set(localSessionId, seq);
  const entry: LoggedRecord = { seq, at: Date.now(), record, localId };
  let log = recordLogs.get(localSessionId);
  if (!log) { log = []; recordLogs.set(localSessionId, log); }
  log.push(entry);
  if (log.length > RECORD_LOG_MAX) log.splice(0, log.length - RECORD_LOG_MAX);
  const subs = recordSubs.get(localSessionId);
  if (subs) for (const fn of subs) { try { fn(entry); } catch { /* subscriber's problem */ } }
}

/** Records for a session: everything after `after` (seq), or the last `last`. */
export function sessionRecords(localSessionId: string, opts: { after?: number; last?: number } = {}): LoggedRecord[] {
  const log = recordLogs.get(localSessionId) ?? [];
  let out = opts.after !== undefined ? log.filter((r) => r.seq > opts.after!) : log;
  if (opts.last !== undefined) out = out.slice(-opts.last);
  return out;
}
export function latestRecordSeq(localSessionId: string): number { return recordSeqs.get(localSessionId) ?? 0; }
export function subscribeRecords(localSessionId: string, fn: (r: LoggedRecord) => void): () => void {
  let subs = recordSubs.get(localSessionId);
  if (!subs) { subs = new Set(); recordSubs.set(localSessionId, subs); }
  subs.add(fn);
  return () => { subs!.delete(fn); };
}
export function forgetRecords(localSessionId: string): void { recordLogs.delete(localSessionId); recordSeqs.delete(localSessionId); recordSubs.delete(localSessionId); }

/** Where RelaySession.send delivers records. One sink per process (the
 *  nucleus lane); null while no lane is running — records are then dropped,
 *  exactly as before the lane existed. */
export type RecordSink = (localSessionId: string, wire: WireRecord, localId?: string) => void;
let recordSink: RecordSink | null = null;
export function setRecordSink(sink: RecordSink | null): void { recordSink = sink; }
let outboundDegraded = false;
const receiptHolders = new Set<RelaySession>();
/** The lane reports its spool's health here (see RelaySession.outboundPersistDegraded). */
export function setOutboundPersistDegraded(v: boolean): void {
  if (v !== outboundDegraded) process.stderr.write(`[relay] outbound persistence ${v ? "DEGRADED — adapter checkpoints held" : "restored"}\n`);
  outboundDegraded = v;
  if (!v) for (const rs of [...receiptHolders]) rs.flushHeldReceipts();
}

/** Build the session card holder for a local session. Purely local: the
 *  relay-side v2 session row is created by the nucleus lane at spawn/bind,
 *  and the card reaches it through the publisher the lane registers. */
export function createRelaySession(
  client: RelayClient,
  opts: { tag?: string; cwd: string; id: string; state?: JoyLifecycleState; flavor?: string },
): RelaySession {
  const state = opts.state ?? 'running';
  const metadata: Record<string, unknown> = { path: opts.cwd, host: hostname(), version: '0.1.0', machineId: client.creds.machineId, joy__source: 'joy-daemon', joy__sessionId: opts.id, joy__state: state };
  // Agent flavor drives the app's per-agent rendering (codex diff/patch views).
  // Absent → the app treats a joy-daemon session as claude.
  if (opts.flavor) metadata.flavor = opts.flavor;
  // A settled handoff's peer link lives in the window record: the holder is
  // rebuilt blank on every restart (session or daemon), and the card was the
  // only place the link existed — "Hand back" then refused a valid handback
  // as "not picked up" (codex review, 2026-09-04).
  const handoff = loadWindowRecord(opts.id)?.handoff;
  if (handoff) metadata.joy__handoff = handoff;
  return new RelaySession({ client, relaySessionId: opts.id, metadata });
}

// ── Util ──────────────────────────────────────────────────────────────────────

function log(msg: string): void { process.stderr.write(`[relay] ${msg}\n`); }
