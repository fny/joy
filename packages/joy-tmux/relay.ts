/**
 * Relay integration for joy-tmux.
 * Self-contained — no deps on joy-daemon internals.
 * External deps: socket.io-client, tweetnacl.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { io, type Socket } from 'socket.io-client';
import tweetnacl from 'tweetnacl';

// ── Types ──────────────────────────────────────────────────────────────────────

export type EncryptionVariant = 'legacy' | 'dataKey';

export interface Credentials {
  token: string;
  serverUrl: string;
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
  const happyHome = process.env.HAPPY_HOME_DIR
    ? process.env.HAPPY_HOME_DIR.replace(/^~/, homedir())
    : join(homedir(), '.happy');

  const accessKeyPath = join(happyHome, 'access.key');
  if (!existsSync(accessKeyPath)) return null;

  try {
    const ak = JSON.parse(readFileSync(accessKeyPath, 'utf8')) as {
      token?: string;
      encryption?: { publicKey?: string; machineKey?: string; secret?: string };
    };
    if (!ak.token) return null;

    let serverUrl = process.env.HAPPY_SERVER_URL ?? DEFAULT_SERVER_URL;
    try {
      const s = JSON.parse(readFileSync(join(happyHome, 'settings.json'), 'utf8')) as { serverUrl?: string };
      if (s.serverUrl && !process.env.HAPPY_SERVER_URL) serverUrl = s.serverUrl;
    } catch {}

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

    return { token: ak.token, serverUrl, encryption };
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
}

export class RelayClient {
  readonly serverUrl: string;
  private readonly creds: Credentials;
  private socket: Socket | null = null;
  private listeners = new Map<string, Set<() => void>>();

  constructor(creds: Credentials) {
    this.creds = creds;
    this.serverUrl = creds.serverUrl;
  }

  connect(): void {
    if (this.socket) return;
    this.socket = io(this.creds.serverUrl, {
      transports: ['websocket'],
      auth: { token: this.creds.token, clientType: 'machine-scoped' },
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 10_000,
    });
    this.socket.on('connect', () => log('socket connected'));
    this.socket.on('disconnect', (r: string) => log(`socket disconnected: ${r}`));
    this.socket.on('update', (p: unknown) => this.handlePoke(p));
  }

  close(): void { this.socket?.close(); this.socket = null; }

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

  async createSession(opts: { tag: string; metadata: unknown }): Promise<CreateSessionResult> {
    let sessionKey: Uint8Array;
    let variant: EncryptionVariant;
    let dataEncryptionKeyB64: string | null = null;

    if (this.creds.encryption.type === 'dataKey') {
      sessionKey = randomBytesU8(32);
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
    const data = await res.json() as { session: { id: string } };
    return { sessionId: data.session.id, sessionKey, variant };
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

export class RelaySession {
  private readonly client: RelayClient;
  readonly relaySessionId: string;
  private readonly sessionKey: Uint8Array;
  private readonly variant: EncryptionVariant;
  private lastSeq = 0;
  private queue: Array<{ localId: string; wire: WireRecord; attempts: number }> = [];
  private draining = false;

  onMessage: (text: string) => void = () => {};

  constructor(opts: {
    client: RelayClient;
    relaySessionId: string;
    sessionKey: Uint8Array;
    variant: EncryptionVariant;
  }) {
    this.client = opts.client;
    this.relaySessionId = opts.relaySessionId;
    this.sessionKey = opts.sessionKey;
    this.variant = opts.variant;
  }

  start(): void {
    this.client.subscribe(this.relaySessionId, () => void this.pull());
    this.client.emitAlive(this.relaySessionId, false);
  }

  private async pull(): Promise<void> {
    try {
      let { messages, hasMore } = await this.client.readSince(this.relaySessionId, this.lastSeq);
      while (messages.length > 0) {
        for (const msg of messages) {
          if (msg.seq > this.lastSeq) this.lastSeq = msg.seq;
          const dec = this.client.decryptMessage(msg, this.sessionKey, this.variant);
          if (!isObj(dec) || dec['role'] !== 'user') continue;
          const c = dec['content'] as { type?: string; text?: string } | undefined;
          if (c?.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
            this.onMessage(c.text.trim());
          }
        }
        if (!hasMore) break;
        ({ messages, hasMore } = await this.client.readSince(this.relaySessionId, this.lastSeq));
      }
    } catch (e) { log(`pull error for ${this.relaySessionId}: ${e}`); }
  }

  send(wire: WireRecord): void {
    this.queue.push({ localId: crypto.randomUUID(), wire, attempts: 0 });
    void this.drain();
  }

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
        const delay = Math.min(500 * 2 ** item.attempts, 30_000);
        log(`send failed (attempt ${item.attempts}), retrying in ${delay}ms: ${e}`);
        await Bun.sleep(delay);
      }
    }
    this.draining = false;
  }

  setThinking(thinking: boolean): void {
    this.client.emitAlive(this.relaySessionId, thinking);
  }
}

// ── Wire encoding ──────────────────────────────────────────────────────────────

function sessionEnvelope(ev: Record<string, unknown>, opts: { turn: string; claudeUuid?: string }): WireRecord {
  const data: Record<string, unknown> = {
    id: crypto.randomUUID(),
    time: Date.now(),
    role: 'agent',
    turn: opts.turn,
    ev,
  };
  if (opts.claudeUuid) data.claudeUuid = opts.claudeUuid;
  return { role: 'session', content: { type: 'session', data }, meta: { sentFrom: 'joy' } };
}

export function encodeTurnStart(opts: { turn: string; claudeUuid?: string }): WireRecord {
  return sessionEnvelope({ t: 'turn-start' }, opts);
}

export function encodeTextEvent(text: string, opts: { turn: string; claudeUuid?: string }): WireRecord {
  return sessionEnvelope({ t: 'text', text }, opts);
}

export function encodeToolCallStart(opts: {
  call: string; name: string; input: unknown; turn: string; claudeUuid?: string;
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

export function encodeToolCallEnd(call: string, opts: { turn: string; claudeUuid?: string }): WireRecord {
  return sessionEnvelope({ t: 'tool-call-end', call }, opts);
}

export function encodeTurnEnd(status: 'completed' | 'failed' | 'cancelled', opts: { turn: string }): WireRecord {
  return sessionEnvelope({ t: 'turn-end', status }, opts);
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
  opts: { tag: string; cwd: string },
): Promise<RelaySession> {
  const result = await client.createSession({
    tag: opts.tag,
    metadata: { path: opts.cwd, host: hostname(), version: '0.1.0' },
  });
  return new RelaySession({
    client,
    relaySessionId: result.sessionId,
    sessionKey: result.sessionKey,
    variant: result.variant,
  });
}

// ── Util ──────────────────────────────────────────────────────────────────────

function log(msg: string): void { process.stderr.write(`[relay] ${msg}\n`); }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
