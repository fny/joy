/**
 * Relay integration for joy-tmux.
 * Self-contained — no deps on joy-daemon internals.
 * External deps: socket.io-client, tweetnacl.
 */
import { setTimeout as sleep } from "timers/promises";
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { hostname, platform } from 'node:os';
import { happyHomeDir, joyStateDir } from '../paths';
import { io, type Socket } from 'socket.io-client';
import tweetnacl from 'tweetnacl';

// ── Types ──────────────────────────────────────────────────────────────────────

export type EncryptionVariant = 'legacy' | 'dataKey';

export interface Credentials {
  token: string;
  serverUrl: string;
  machineId: string;
  encryption:
    | { type: 'dataKey'; publicKey: Uint8Array; machineKey: Uint8Array }
    | { type: 'legacy'; secret: Uint8Array };
}

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

function encryptLegacy(data: unknown, key: Uint8Array): Uint8Array {
  const nonce = randomBytesU8(tweetnacl.secretbox.nonceLength);
  const pt = new TextEncoder().encode(JSON.stringify(data));
  const ct = tweetnacl.secretbox(pt, nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce);
  out.set(ct, nonce.length);
  return out;
}

function decryptLegacy(buf: Uint8Array, key: Uint8Array): unknown | null {
  const n = tweetnacl.secretbox.nonceLength;
  if (buf.length < n) return null;
  const pt = tweetnacl.secretbox.open(buf.slice(n), buf.slice(0, n), key);
  if (!pt) return null;
  try { return JSON.parse(new TextDecoder().decode(pt)); } catch { return null; }
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

function encryptWire(variant: EncryptionVariant, key: Uint8Array, data: unknown): Uint8Array {
  return variant === 'legacy' ? encryptLegacy(data, key) : encryptDataKey(data, key);
}

function decryptWire(variant: EncryptionVariant, key: Uint8Array, buf: Uint8Array): unknown | null {
  return variant === 'legacy' ? decryptLegacy(buf, key) : decryptDataKey(buf, key);
}

// ── Blob crypto (image attachments) ────────────────────────────────────────────
//
// Mirrors happy-cli's deriveKey + decryptBlob: HMAC-SHA512 key tree derivation
// rooted at the encryption secret, then NaCl secretbox unwrap. Used to download
// + decrypt image attachments that the app uploads via /v1/sessions/{id}/attachments.

function hmacSha512(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac('sha512', key).update(data).digest());
}

function deriveKeyTreeRoot(seed: Uint8Array, usage: string): { key: Uint8Array; chainCode: Uint8Array } {
  const I = hmacSha512(new TextEncoder().encode(usage + ' Master Seed'), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveKeyTreeChild(chainCode: Uint8Array, index: string): { key: Uint8Array; chainCode: Uint8Array } {
  const data = new Uint8Array([0, ...new TextEncoder().encode(index)]);
  const I = hmacSha512(chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

function deriveKey(master: Uint8Array, usage: string, path: string[]): Uint8Array {
  let state = deriveKeyTreeRoot(master, usage);
  for (const seg of path) {
    state = deriveKeyTreeChild(state.chainCode, seg);
  }
  return state.key;
}

/**
 * Decrypt a NaCl secretbox bundle: [24-byte nonce][ciphertext + 16-byte tag].
 * Returns null on tamper / wrong key. Matches happy-cli's decryptBlob.
 */
function decryptBlob(bundle: Uint8Array, key: Uint8Array): Uint8Array | null {
  const NONCE_LEN = tweetnacl.secretbox.nonceLength;
  if (bundle.length < NONCE_LEN + 16) return null;
  const nonce = bundle.slice(0, NONCE_LEN);
  const ciphertext = bundle.slice(NONCE_LEN);
  const plain = tweetnacl.secretbox.open(ciphertext, nonce, key);
  return plain ? new Uint8Array(plain) : null;
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

const DEFAULT_SERVER_URL = 'https://api.cluster-fluster.com';

export function loadCredentials(): Credentials | null {
  const happyHome = happyHomeDir();

  const accessKeyPath = join(happyHome, 'access.key');
  if (!existsSync(accessKeyPath)) return null;

  try {
    const ak = JSON.parse(readFileSync(accessKeyPath, 'utf8')) as {
      token?: string;
      encryption?: { publicKey?: string; machineKey?: string; secret?: string };
    };
    if (!ak.token) return null;

    let serverUrl = process.env.HAPPY_SERVER_URL ?? DEFAULT_SERVER_URL;
    let machineId: string | undefined;
    try {
      const s = JSON.parse(readFileSync(join(happyHome, 'settings.json'), 'utf8')) as { serverUrl?: string; machineId?: string };
      if (s.serverUrl && !process.env.HAPPY_SERVER_URL) serverUrl = s.serverUrl;
      if (s.machineId) machineId = s.machineId;
    } catch {}
    // M5 (machineId): a random fallback would silently break RPC on every restart
    if (!machineId) {
      process.stderr.write('[relay] WARNING: machineId missing from settings.json — RPC handlers will not be reachable. Run the happy-cli daemon once to populate it.\n');
      machineId = crypto.randomUUID();
    }

    let encryption: Credentials['encryption'] | null = null;
    if (ak.encryption?.publicKey) {
      encryption = {
        type: 'dataKey',
        publicKey: b64decode(ak.encryption.publicKey),
        machineKey: ak.encryption.machineKey ? b64decode(ak.encryption.machineKey) : new Uint8Array(),
      };
    } else if (ak.encryption?.secret) {
      encryption = { type: 'legacy', secret: b64decode(ak.encryption.secret) };
    }
    if (!encryption) return null;

    return { token: ak.token, serverUrl, machineId, encryption };
  } catch { return null; }
}

// ── RPC encryption (matches happy-cli encryptWithDataKey / decryptWithDataKey) ─

function encryptRpc(key: Uint8Array, data: unknown): string {
  const nonce = randomBytesU8(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const pt = new TextEncoder().encode(JSON.stringify(data));
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  // version(1=0x00) + nonce(12) + ciphertext + tag(16)
  const bundle = new Uint8Array(1 + 12 + ct.length + 16);
  bundle[0] = 0;
  bundle.set(nonce, 1);
  bundle.set(new Uint8Array(ct), 13);
  bundle.set(new Uint8Array(tag), 13 + ct.length);
  return Buffer.from(bundle).toString('base64');
}

function decryptRpc(key: Uint8Array, b64: string): unknown {
  const bundle = Buffer.from(b64, 'base64');
  if (bundle.length < 1 + 12 + 16 || bundle[0] !== 0) return null;
  const nonce = bundle.slice(1, 13);
  const tag = bundle.slice(bundle.length - 16);
  const ct = bundle.slice(13, bundle.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(new TextDecoder().decode(pt));
  } catch { return null; }
}

// ── Relay HTTP + socket client ────────────────────────────────────────────────

interface RawMessage {
  id: string;
  seq: number;
  content: string | { c: string; t?: string };
  localId: string | null;
}

function rawContentB64(c: RawMessage['content']): string | null {
  if (typeof c === 'string') return c;
  if (c && typeof c === 'object' && typeof c.c === 'string') return c.c;
  return null;
}

export interface CreateSessionResult {
  sessionId: string;
  sessionKey: Uint8Array;
  variant: EncryptionVariant;
  // The server's CURRENT metadata + version. On tag-dedup the server returns the
  // EXISTING session (it ignores the POSTed metadata), so this is the source of
  // truth to merge onto — using it avoids clobbering a previously-set title.
  metadata: Record<string, unknown> | null;
  metadataVersion: number;
}

export class RelayClient {
  readonly serverUrl: string;
  readonly creds: Credentials;
  private socket: Socket | null = null;
  private listeners = new Map<string, Set<() => void>>();
  private activeSessions = new Set<RelaySession>();
  private machineAliveTimer: ReturnType<typeof setInterval> | null = null;

  constructor(creds: Credentials) {
    this.creds = creds;
    this.serverUrl = creds.serverUrl;
  }

  trackSession(rs: RelaySession): void { this.activeSessions.add(rs); }
  untrackSession(rs: RelaySession): void { this.activeSessions.delete(rs); }

  onReconnect: (() => void) | null = null;

  private rpcHandlers = new Map<string, (params: unknown) => Promise<unknown>>();

  /** Register a session-scoped RPC handler that the app calls via apiSocket.sessionRPC. */
  registerSessionRpcHandler(relaySessionId: string, method: string, handler: (params: unknown) => Promise<unknown>): void {
    const prefixed = `${relaySessionId}:${method}`;
    this.rpcHandlers.set(prefixed, handler);
    log(`rpc: registering session ${prefixed}`);
    this.socket?.emit('rpc-register', { method: prefixed });
  }

  /** Drop every session-scoped RPC handler for a relay session (called on
   *  detach/stop) so dead handlers neither linger in the map nor get
   *  re-registered on the next socket reconnect. */
  unregisterSessionRpcHandlers(relaySessionId: string): void {
    const prefix = `${relaySessionId}:`;
    for (const key of this.rpcHandlers.keys()) {
      if (key.startsWith(prefix)) this.rpcHandlers.delete(key);
    }
  }

  registerRpcHandler(method: string, handler: (params: unknown) => Promise<unknown>): void {
    const prefixed = `${this.creds.machineId}:${method}`;
    this.rpcHandlers.set(prefixed, handler);
    log(`rpc: registering ${prefixed}`);
    this.socket?.emit('rpc-register', { method: prefixed }, (ack: unknown) => {
      log(`rpc: registered ${prefixed} ack=${JSON.stringify(ack)}`);
    });
  }

  /** Heartbeat machine presence so the app shows this machine online. The
   *  server marks the machine active on each machine-alive and lapses it to
   *  offline without one (this is what happy-cli's daemon did — joy now owns
   *  it). Beats immediately on every (re)connect, then every 20s. */
  private startMachineAlive(): void {
    const beat = () => this.socket?.emit('machine-alive', { machineId: this.creds.machineId, time: Date.now() });
    beat();
    if (!this.machineAliveTimer) this.machineAliveTimer = setInterval(beat, 20_000);
  }

  connect(): void {
    if (this.socket) return;
    this.socket = io(this.creds.serverUrl, {
      path: '/v1/updates',
      transports: ['websocket'],
      auth: { token: this.creds.token, clientType: 'machine-scoped', machineId: this.creds.machineId },
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });
    let firstConnect = true;
    this.socket.on('connect', () => {
      log('socket connected');
      for (const rs of this.activeSessions) rs.setThinking(false);
      // Re-register all RPC handlers on (re)connect
      for (const method of this.rpcHandlers.keys()) {
        log(`rpc: re-registering ${method}`);
        this.socket?.emit('rpc-register', { method });
      }
      this.startMachineAlive();
      if (!firstConnect) this.onReconnect?.();
      firstConnect = false;
    });
    this.socket.on('disconnect', (r: string) => log(`socket disconnected: ${r}`));
    this.socket.on('connect_error', (e: Error) => log(`socket connect_error: ${e.message}`));
    this.socket.on('update', (p: unknown) => this.handlePoke(p));
    this.socket.on('rpc-request', async (req: unknown, callback: (res: string) => void) => {
      if (!isObj(req)) return;
      const method = String(req['method'] ?? '');
      log(`rpc: incoming request method=${method}`);
      const handler = this.rpcHandlers.get(method);
      const key = this.creds.encryption.type === 'dataKey'
        ? this.creds.encryption.machineKey
        : this.creds.encryption.secret;
      if (!handler) {
        callback(encryptRpc(key, { error: 'Method not found' }));
        return;
      }
      try {
        const params = decryptRpc(key, String(req['params'] ?? ''));
        const result = await handler(params);
        callback(encryptRpc(key, result));
      } catch (e) {
        callback(encryptRpc(key, { error: String(e) }));
      }
    });
  }

  close(): void { this.socket?.close(); this.socket = null; }

  /** Emit the server's version-checked session metadata update (used for summaries). */
  updateSessionMetadata(sid: string, expectedVersion: number, metadataB64: string): Promise<{ result: string; version?: number } | null> {
    return new Promise((resolve) => {
      if (!this.socket) { resolve(null); return; }
      let done = false;
      const finish = (v: { result: string; version?: number } | null) => { if (!done) { done = true; resolve(v); } };
      this.socket.emit('update-metadata', { sid, expectedVersion, metadata: metadataB64 }, (ack: unknown) => {
        finish(isObj(ack) ? (ack as { result: string; version?: number }) : null);
      });
      setTimeout(() => finish(null), 5000);
    });
  }

  private handlePoke(payload: unknown): void {
    const sid = isObj(payload) ? String(payload['sessionId'] ?? '') : '';
    if (sid && this.listeners.has(sid)) {
      for (const cb of this.listeners.get(sid)!) try { cb(); } catch {}
      return;
    }
    for (const s of this.listeners.values()) for (const cb of s) try { cb(); } catch {}
  }

  subscribe(sessionId: string, onPoke: () => void): () => void {
    if (!this.listeners.has(sessionId)) this.listeners.set(sessionId, new Set());
    this.listeners.get(sessionId)!.add(onPoke);
    return () => {
      const s = this.listeners.get(sessionId);
      if (s) { s.delete(onPoke); if (!s.size) this.listeners.delete(sessionId); }
    };
  }

  private url(path: string): string {
    return `${this.creds.serverUrl.replace(/\/$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.creds.token}`, 'Content-Type': 'application/json' };
  }

  /**
   * Download + decrypt an attachment blob. Mirrors happy-cli's
   * downloadAndDecryptAttachment. Two-step flow:
   *   1. POST /v1/sessions/{id}/attachments/request-download → { downloadUrl }
   *   2. GET downloadUrl → encrypted bytes (NaCl secretbox bundle)
   * The blob key is derived from the session's encryption key with the
   * "Happy Blobs" usage and a variant-specific path. Returns null on any
   * failure (network, auth, decryption).
   */
  async downloadAndDecryptAttachment(
    relaySessionId: string,
    ref: string,
    sessionKey: Uint8Array,
    variant: EncryptionVariant,
  ): Promise<Uint8Array | null> {
    try {
      // Step 1: request a download URL (the server may presign an S3 URL or
      // hand back a self-served path requiring our bearer token).
      const reqRes = await fetch(this.url(`/v1/sessions/${relaySessionId}/attachments/request-download`), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ ref }),
      });
      if (!reqRes.ok) return null;
      const reqData = await reqRes.json() as { downloadUrl?: string };
      if (!reqData.downloadUrl) return null;

      // Step 2: fetch the encrypted bytes. Only send bearer when the URL
      // points back at our server — S3 presigned URLs reject extra headers.
      const isServerUrl = reqData.downloadUrl.startsWith(this.creds.serverUrl);
      const dlRes = await fetch(reqData.downloadUrl, {
        headers: isServerUrl ? { Authorization: `Bearer ${this.creds.token}` } : {},
      });
      if (!dlRes.ok) return null;
      const encrypted = new Uint8Array(await dlRes.arrayBuffer());

      // Step 3: decrypt with the per-session blob key.
      // Legacy sessions: deriveKey(secret, 'Happy Blobs', ['master']).
      // DataKey sessions: deriveKey(dataKey, 'Happy Blobs', ['session']).
      const path = variant === 'dataKey' ? ['session'] : ['master'];
      const blobKey = deriveKey(sessionKey, 'Happy Blobs', path);
      return decryptBlob(encrypted, blobKey);
    } catch (e) {
      log(`downloadAndDecryptAttachment failed for ${ref}: ${e}`);
      return null;
    }
  }

  /**
   * Upsert the machine row's metadata server-side. Mirrors happy-cli's
   * `getOrCreateMachine` (api.ts:144): POST /v1/machines with the
   * machineId and an encrypted MachineMetadata payload.
   *
   * The point of doing this from joy-tmux is purely a UX guarantee:
   * the app's path picker uses `selectedMachine.metadata.homeDir` to
   * format paths as `~/foo`. If happy-cli's daemon has never run on
   * this host, that field is undefined and the picker shows literal
   * `~/foo`. joy-tmux always knows its homedir, so we can guarantee
   * the field is set.
   *
   * Caveat: this REST POST is an unconditional upsert — the server
   * replaces the full metadata blob. If happy-cli's daemon had set
   * optional fields (cliAvailability, resumeSupport), our upsert
   * wipes them until happy-cli re-upserts on its next session spawn.
   * Acceptable trade-off for the picker reliability gain.
   */
  async getOrCreateMachine(metadata: Record<string, unknown>): Promise<boolean> {
    try {
      let encryptionKey: Uint8Array;
      let variant: EncryptionVariant;
      let dataEncryptionKeyB64: string | undefined;

      if (this.creds.encryption.type === 'dataKey') {
        variant = 'dataKey';
        encryptionKey = this.creds.encryption.machineKey;
        // Same envelope as createSession: [0x00][encrypted(machineKey, publicKey)]
        // so the server can hand the dataKey to authorized clients.
        const encryptedKey = libsodiumEncryptForPublicKey(encryptionKey, this.creds.encryption.publicKey);
        const bundle = new Uint8Array(1 + encryptedKey.length);
        bundle.set([0], 0);
        bundle.set(encryptedKey, 1);
        dataEncryptionKeyB64 = b64encode(bundle);
      } else {
        variant = 'legacy';
        encryptionKey = this.creds.encryption.secret;
      }

      const r = await fetch(this.url('/v1/machines'), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          id: this.creds.machineId,
          metadata: b64encode(encryptWire(variant, encryptionKey, metadata)),
          dataEncryptionKey: dataEncryptionKeyB64,
        }),
      });
      return r.ok;
    } catch (e) {
      log(`getOrCreateMachine failed: ${e}`);
      return false;
    }
  }

  /**
   * Mark a session inactive on the API server (flips `active=false`).
   * Mirrors happy-cli's `deactivateSession`: POST /v1/sessions/{id}/archive.
   * Without this the session keeps showing as active in the app even after
   * the underlying tmux window has been killed, because killSession only
   * cleans up local state — it doesn't tell the server to archive.
   */
  async archiveSession(relaySessionId: string): Promise<boolean> {
    try {
      const r = await fetch(this.url(`/v1/sessions/${relaySessionId}/archive`), {
        method: 'POST',
        headers: this.headers(),
        body: '{}',
      });
      return r.ok;
    } catch (e) {
      log(`archiveSession failed for ${relaySessionId}: ${e}`);
      return false;
    }
  }

  /**
   * Send a push notification to all the user's devices (mirrors happy-cli's
   * `notify`): fetch the account's Expo push tokens from the server (authed
   * with the daemon's bearer), then POST the messages straight to Expo. Returns
   * how many devices were targeted.
   */
  async sendPush(title: string, body: string): Promise<{ sent: number }> {
    const res = await fetch(this.url('/v1/push-tokens'), { headers: this.headers() });
    if (!res.ok) throw new Error(`push-tokens: HTTP ${res.status}`);
    const data = await res.json() as { tokens?: { token: string }[] };
    const tokens = (data.tokens ?? []).map(t => t.token).filter(Boolean);
    if (tokens.length === 0) return { sent: 0 };
    const messages = tokens.map(to => ({
      to, title, body: body || undefined, sound: 'default',
      data: { source: 'joy-cli', timestamp: Date.now() },
    }));
    const r = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!r.ok) throw new Error(`expo push: HTTP ${r.status}`);
    return { sent: tokens.length };
  }

  async createSession(opts: { tag: string; metadata: unknown }): Promise<CreateSessionResult> {
    let sessionKey: Uint8Array;
    let variant: EncryptionVariant;
    let dataEncryptionKeyB64: string | null = null;

    if (this.creds.encryption.type === 'dataKey') {
      // machineKey is the stable per-machine symmetric key stored in access.key.
      // Using it as the sessionKey ensures messages can be decrypted across restarts,
      // even when the server deduplicates sessions by tag and returns an existing session ID.
      sessionKey = this.creds.encryption.machineKey;
      variant = 'dataKey';
      const encryptedKey = libsodiumEncryptForPublicKey(sessionKey, this.creds.encryption.publicKey);
      const bundle = new Uint8Array(1 + encryptedKey.length);
      bundle.set([0], 0); bundle.set(encryptedKey, 1);
      dataEncryptionKeyB64 = b64encode(bundle);
    } else {
      sessionKey = this.creds.encryption.secret;
      variant = 'legacy';
    }

    const res = await fetch(this.url('/v1/sessions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        tag: opts.tag,
        metadata: b64encode(encryptWire(variant, sessionKey, opts.metadata)),
        agentState: null,
        dataEncryptionKey: dataEncryptionKeyB64,
      }),
    });
    if (!res.ok) throw new Error(`createSession: HTTP ${res.status}`);
    const data = await res.json() as { session: { id: string; metadata?: string | null; metadataVersion?: number } };
    let serverMeta: Record<string, unknown> | null = null;
    if (data.session.metadata) {
      try { serverMeta = decryptWire(variant, sessionKey, b64decode(data.session.metadata)) as Record<string, unknown> | null; } catch { serverMeta = null; }
    }
    return { sessionId: data.session.id, sessionKey, variant, metadata: serverMeta, metadataVersion: data.session.metadataVersion ?? 0 };
  }

  async append(sessionId: string, encrypted: Uint8Array, localId: string): Promise<{ seq: number }> {
    const res = await fetch(this.url(`/v3/sessions/${encodeURIComponent(sessionId)}/messages`), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messages: [{ content: b64encode(encrypted), localId }] }),
    });
    if (!res.ok) throw new Error(`append: HTTP ${res.status}`);
    const data = await res.json() as { messages: Array<{ seq: number }> };
    if (!data.messages?.[0]) throw new Error('append: empty response');
    return data.messages[0];
  }

  async readSince(sessionId: string, afterSeq: number, limit = 100): Promise<{ messages: RawMessage[]; hasMore: boolean }> {
    const res = await fetch(
      this.url(`/v3/sessions/${encodeURIComponent(sessionId)}/messages?after_seq=${afterSeq}&limit=${limit}`),
      { headers: this.headers() },
    );
    if (!res.ok) throw new Error(`readSince: HTTP ${res.status}`);
    return res.json() as Promise<{ messages: RawMessage[]; hasMore: boolean }>;
  }

  async fetchLastSeq(sessionId: string): Promise<number> {
    let lastSeq = 0;
    let hasMore = true;
    while (hasMore) {
      const r = await this.readSince(sessionId, lastSeq, 100);
      for (const m of r.messages) if (m.seq > lastSeq) lastSeq = m.seq;
      hasMore = r.hasMore;
    }
    return lastSeq;
  }

  emitAlive(sessionId: string, thinking: boolean): void {
    this.socket?.volatile.emit('session-alive', {
      sid: sessionId, time: Date.now(), thinking, mode: 'remote',
    });
  }

  decryptMessage(msg: RawMessage, key: Uint8Array, variant: EncryptionVariant): unknown | null {
    const b64 = rawContentB64(msg.content);
    if (!b64) return null;
    try { return decryptWire(variant, key, b64decode(b64)); } catch { return null; }
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

export class RelaySession {
  private readonly client: RelayClient;
  readonly relaySessionId: string;
  private readonly sessionKey: Uint8Array;
  private readonly variant: EncryptionVariant;
  private lastSeq: number;
  private queue: Array<{ localId: string; wire: WireRecord; attempts: number }> = [];
  private draining = false;
  // Last-known session metadata blob + its server version, so we can merge in
  // a summary update (Claude's ai-title) without clobbering the other fields.
  private metadata: Record<string, unknown> | null;
  private metadataVersion = 0;

  onMessage: (text: string, seq: number) => void = () => {};
  /**
   * Fires for each file/attachment event the app sends ahead of a user
   * message (envelope `role:'session'`, `ev.t:'file'`). The handler is
   * expected to download + decrypt the blob (via the parent RelayClient)
   * and stash it for the next user message.
   */
  onFileEvent: (ev: { ref: string; name: string; size: number; mimeType?: string }) => void = () => {};
  /** Exposed so handlers (e.g. attachment download) can derive blob keys. */
  get encryptionMaterial(): { sessionKey: Uint8Array; variant: EncryptionVariant } {
    return { sessionKey: this.sessionKey, variant: this.variant };
  }

  constructor(opts: {
    client: RelayClient;
    relaySessionId: string;
    sessionKey: Uint8Array;
    variant: EncryptionVariant;
    initialSeq?: number;
    metadata?: Record<string, unknown> | null;
    metadataVersion?: number;
  }) {
    this.client = opts.client;
    this.relaySessionId = opts.relaySessionId;
    this.sessionKey = opts.sessionKey;
    this.variant = opts.variant;
    this.lastSeq = opts.initialSeq ?? 0;
    this.metadata = opts.metadata ?? null;
    this.metadataVersion = opts.metadataVersion ?? 0;
  }

  /**
   * Merge a patch into the session metadata and persist it (server is
   * version-checked; retries on mismatch). The single write path so the title,
   * lifecycle state, etc. don't clobber each other.
   */
  private async mergeMetadata(patch: Record<string, unknown>): Promise<void> {
    if (!this.metadata) return;
    const merged = { ...this.metadata, ...patch };
    const enc = b64encode(encryptWire(this.variant, this.sessionKey, merged));
    for (let attempt = 0; attempt < 3; attempt++) {
      const ack = await this.client.updateSessionMetadata(this.relaySessionId, this.metadataVersion, enc);
      if (!ack) return;
      if (ack.result === 'success') {
        this.metadata = merged;
        if (typeof ack.version === 'number') this.metadataVersion = ack.version;
        return;
      }
      if (ack.result === 'version-mismatch' && typeof ack.version === 'number') {
        this.metadataVersion = ack.version;
        continue; // retry with the server's current version
      }
      return;
    }
  }

  /**
   * Set the session's title (summary) — joy uses Claude's ai-title so the app
   * shows the real conversation title instead of "New Chat".
   */
  async updateSummary(title: string): Promise<void> {
    const current = this.metadata?.summary as { text?: string } | undefined;
    if (current?.text === title) return; // unchanged
    await this.mergeMetadata({ summary: { text: title, updatedAt: Date.now() } });
  }

  /**
   * Set the joy lifecycle state the app reads to colour the status:
   * 'running' (alive), 'detached' (Claude died, window still around — red), or
   * 'archived' (killed/cleaned up). Drives the red detached indicator.
   */
  async updateJoyState(state: JoyLifecycleState): Promise<void> {
    if ((this.metadata?.joy__state as string | undefined) === state) return;
    await this.mergeMetadata({ joy__state: state });
  }

  /**
   * Set (or clear, with null) the 500-error auto-retry banner the app shows
   * while a failed turn is being re-sent on a backoff schedule.
   */
  async updateRetry(info: JoyRetryInfo | null): Promise<void> {
    await this.mergeMetadata({ joy__retry: info });
  }

  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;

  start(): void {
    this.client.trackSession(this);
    this.unsubscribe = this.client.subscribe(this.relaySessionId, () => void this.pull());
    this.client.emitAlive(this.relaySessionId, false);
    // Poll for incoming messages every 3s (machine-scoped socket doesn't receive update pokes)
    // and send keepalive every 30s
    let ticks = 0;
    this.heartbeatTimer = setInterval(() => {
      void this.pull();
      if (++ticks % 10 === 0) this.client.emitAlive(this.relaySessionId, false);
    }, 3_000);
  }

  stop(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.client.unregisterSessionRpcHandlers(this.relaySessionId);
    this.client.untrackSession(this);
  }

  private async pull(): Promise<void> {
    try {
      let { messages, hasMore } = await this.client.readSince(this.relaySessionId, this.lastSeq);
      if (messages.length > 0) log(`pull ${this.relaySessionId}: got ${messages.length} msgs, lastSeq=${this.lastSeq}`);
      let advanced = false;
      while (messages.length > 0) {
        for (const msg of messages) {
          // M2: decrypt before advancing seq so a failed decrypt doesn't silently consume the seq
          const dec = this.client.decryptMessage(msg, this.sessionKey, this.variant);
          if (dec === null) {
            log(`pull msg seq=${msg.seq} DECRYPT_FAILED — skipping without advancing seq`);
            continue;
          }
          if (msg.seq > this.lastSeq) { this.lastSeq = msg.seq; advanced = true; }
          log(`pull msg seq=${msg.seq} dec=${JSON.stringify(dec)?.slice(0, 120)}`);
          if (!isObj(dec)) continue;
          const role = dec['role'];

          // File attachment envelope: role='session', ev.t='file'. App sends
          // these ahead of the user-text message; the handler downloads and
          // stashes them, drained on the next text message.
          if (role === 'session') {
            const c = dec['content'] as { type?: string; data?: { ev?: { t?: string; ref?: string; name?: string; size?: number; mimeType?: string } } } | undefined;
            const ev = c?.data?.ev;
            if (c?.type === 'session' && ev?.t === 'file' && typeof ev.ref === 'string' && typeof ev.name === 'string' && typeof ev.size === 'number') {
              this.onFileEvent({ ref: ev.ref, name: ev.name, size: ev.size, mimeType: ev.mimeType });
            }
            continue;
          }

          if (role !== 'user') continue;
          // H1: skip messages sent by joy itself to avoid double-injecting into tmux
          const meta = dec['meta'] as { sentFrom?: string } | undefined;
          if (meta?.sentFrom === 'joy') continue;
          const c = dec['content'] as { type?: string; text?: string } | undefined;
          if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
            this.onMessage(c.text.trim(), msg.seq);
          }
        }
        if (!hasMore) break;
        ({ messages, hasMore } = await this.client.readSince(this.relaySessionId, this.lastSeq));
      }
      // Low: only write to disk when seq actually changed
      if (advanced) savePersistedSeq(this.relaySessionId, this.lastSeq);
    } catch (e) { log(`pull error for ${this.relaySessionId}: ${e}`); }
  }

  send(wire: WireRecord): void {
    this.queue.push({ localId: crypto.randomUUID(), wire, attempts: 0 });
    void this.drain();
  }

  private static readonly MAX_SEND_ATTEMPTS = 10;

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    while (this.queue.length > 0) {
      const item = this.queue[0];
      try {
        const enc = encryptWire(this.variant, this.sessionKey, item.wire);
        await this.client.append(this.relaySessionId, enc, item.localId);
        this.queue.shift();
      } catch (e) {
        item.attempts++;
        // H2: cap retries so a permanent failure (401/404) doesn't wedge the queue forever
        if (item.attempts >= RelaySession.MAX_SEND_ATTEMPTS) {
          log(`send failed after ${item.attempts} attempts, dropping: ${e}`);
          this.queue.shift();
          continue;
        }
        const delay = Math.min(500 * 2 ** item.attempts, 30_000);
        log(`send failed (attempt ${item.attempts}), retrying in ${delay}ms: ${e}`);
        await sleep(delay);
      }
    }
    this.draining = false;
  }

  setThinking(thinking: boolean): void {
    this.client.emitAlive(this.relaySessionId, thinking);
  }

  /** Register a session-scoped RPC handler bound to this relay session. */
  registerRpc(method: string, handler: (params: unknown) => Promise<unknown>): void {
    this.client.registerSessionRpcHandler(this.relaySessionId, method, handler);
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

export function encodeToolCallEnd(call: string, opts: { turn: string; claudeUuid?: string; time?: number }): WireRecord {
  return sessionEnvelope({ t: 'tool-call-end', call }, opts);
}

export function encodeTurnEnd(status: 'completed' | 'failed' | 'cancelled', opts: { turn: string; time?: number }): WireRecord {
  return sessionEnvelope({ t: 'turn-end', status }, opts);
}

// User messages are sorted by the relay's server-assigned createdAt, NOT an
// embedded time — so on a replay burst they'd diverge from agent events (a
// different clock). joyTime carries Claude's transcript timestamp; joy-app
// reads it (MessageMetaSchema.joyTime) and orders joy user messages by it,
// putting both sides on one clock.
export function encodeUserMessage(text: string, timeMs?: number): WireRecord {
  return { role: 'user', content: { type: 'text', text }, meta: { sentFrom: 'joy', joyTime: timeMs } };
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

export function initRelay(): RelayClient | null {
  const creds = loadCredentials();
  if (!creds) { log('no credentials found — relay disabled'); return null; }
  const client = new RelayClient(creds);
  client.connect();
  log(`initialized → ${creds.serverUrl}`);
  return client;
}

export async function createRelaySession(
  client: RelayClient,
  opts: { tag: string; cwd: string; id: string; state?: JoyLifecycleState },
): Promise<RelaySession> {
  const state = opts.state ?? 'running';
  const metadata = { path: opts.cwd, host: hostname(), version: '0.1.0', machineId: client.creds.machineId, joy__source: 'joy-tmux', joy__sessionId: opts.id, joy__state: state };
  const result = await client.createSession({ tag: opts.tag, metadata });
  // Resume from persisted seq so messages sent during downtime are delivered.
  // On first-ever start (no saved seq), fetch to end to avoid replaying history.
  let initialSeq = loadPersistedSeq(result.sessionId);
  if (initialSeq === 0) {
    initialSeq = await client.fetchLastSeq(result.sessionId);
    if (initialSeq > 0) savePersistedSeq(result.sessionId, initialSeq);
  }
  // On tag-dedup the server kept its EXISTING metadata (title, prior joy__state).
  // Use it as the base so we don't wipe the title; fall back to ours for a
  // brand-new session. Then push the intended state (a no-op if unchanged).
  const baseMeta = result.metadata ?? metadata;
  const rs = new RelaySession({
    client,
    relaySessionId: result.sessionId,
    sessionKey: result.sessionKey,
    variant: result.variant,
    initialSeq,
    metadata: baseMeta,
    metadataVersion: result.metadataVersion,
  });
  await rs.updateJoyState(state);
  return rs;
}

// ── lastSeq persistence ───────────────────────────────────────────────────────
// Stores the last processed seq per relay session so messages sent during
// joy-tmux downtime are delivered on next startup, not silently skipped.

function seqStatePath(relaySessionId: string): string {
  const dir = joyStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, `${relaySessionId}.seq`);
}

function loadPersistedSeq(relaySessionId: string): number {
  try {
    const p = seqStatePath(relaySessionId);
    if (existsSync(p)) return parseInt(readFileSync(p, 'utf8').trim(), 10) || 0;
  } catch {}
  return 0;
}

function savePersistedSeq(relaySessionId: string, seq: number): void {
  // Low: write-temp-then-rename for atomic update — crash mid-write can't corrupt
  try {
    const p = seqStatePath(relaySessionId);
    const tmp = p + '.tmp';
    writeFileSync(tmp, String(seq));
    renameSync(tmp, p);
  } catch {}
}

// ── Util ──────────────────────────────────────────────────────────────────────

function log(msg: string): void { process.stderr.write(`[relay] ${msg}\n`); }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
