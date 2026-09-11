// The relay's account-side v2 API, as the app calls it, with one addition:
// a token that renews itself from the account secret on a 401 (the app keeps
// a user logged in; this server has nobody to tap "sign in again").
import { randomBytes, randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import { b64, signKeyPair } from './crypto.mjs';

export class RelayError extends Error {
  constructor(status, code, body) { super(`relay ${status}: ${code}`); this.status = status; this.code = code; this.body = body; }
}

/** POST /auth — a signature over a self-chosen challenge. Auto-creates the
 *  account on first contact. Returns the bearer. */
export async function loginWithSecret(relayUrl, accountSecret, { perimeterKey, fetchImpl = fetch } = {}) {
  const kp = signKeyPair(accountSecret);
  const challenge = new Uint8Array(randomBytes(32));
  const signature = nacl.sign.detached(challenge, kp.secretKey);
  const headers = { 'content-type': 'application/json', 'x-joy-client': 'joy-mcp' };
  if (perimeterKey) headers['x-joy-relay-key'] = perimeterKey;
  const r = await fetchImpl(`${relayUrl}/joy/v2/auth`, {
    method: 'POST', headers,
    body: JSON.stringify({ publicKey: b64(kp.publicKey), challenge: b64(challenge), signature: b64(signature) }),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json?.token) throw new RelayError(r.status, json?.error ?? 'login_failed', json);
  return { token: String(json.token), publicKey: b64(kp.publicKey) };
}

export class RelayClient {
  /** @param {{ relayUrl: string, token: string, perimeterKey?: string, renew?: () => Promise<string>, fetchImpl?: typeof fetch }} opts */
  constructor(opts) {
    this.relayUrl = opts.relayUrl.replace(/\/$/, '');
    this.token = opts.token;
    this.perimeterKey = opts.perimeterKey ?? null;
    this.renew = opts.renew ?? null;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  headers(extra = {}) {
    const h = { authorization: `Bearer ${this.token}`, 'x-joy-client': 'joy-mcp', ...extra };
    if (this.perimeterKey) h['x-joy-relay-key'] = this.perimeterKey;
    return h;
  }

  async call(method, path, body, { raw, retryAuth = true, timeoutMs } = {}) {
    const res = await this.fetchImpl(`${this.relayUrl}/joy/v2${path}`, {
      method,
      headers: this.headers(raw !== undefined ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body),
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    });
    if (res.status === 401 && retryAuth && this.renew) {
      this.token = await this.renew();
      return this.call(method, path, body, { raw, retryAuth: false, timeoutMs });
    }
    if (res.headers.get('content-type')?.includes('application/octet-stream')) {
      if (!res.ok) throw new RelayError(res.status, 'relay_error', null);
      return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()), headers: res.headers };
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new RelayError(res.status, json?.error ?? `http_${res.status}`, json ?? text);
    return json;
  }

  // ── reads ────────────────────────────────────────────────────────────────
  listSessions() { return this.call('GET', '/sessions'); }
  sessionState(id) { return this.call('GET', `/sessions/${encodeURIComponent(id)}`); }
  listMachines() { return this.call('GET', '/machines'); }
  /** Events after `after` (ascending) or before `before` (the page ending there). */
  events(id, { after, before, limit = 200 } = {}) {
    const q = before !== undefined ? `before=${before}` : `after=${after ?? 0}`;
    return this.call('GET', `/sessions/${encodeURIComponent(id)}/events?${q}&limit=${limit}`);
  }
  /** The relay's own prompt rows (its queue view), optionally by status (queued | delivered | …). */
  messages(sessionId, { status, limit = 100 } = {}) {
    return this.call('GET', `/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ''}`);
  }
  turn(sessionId, turnId) { return this.call('GET', `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`); }
  relayStatus() { return this.call('GET', '/relay/status'); }

  // ── writes ───────────────────────────────────────────────────────────────
  /** The durable queue: a sealed prompt in, { messageId, turnId, seq } out. */
  sendCiphertext(sessionId, ciphertext, clientIntentId = randomUUID()) {
    return this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { ciphertext, clientIntentId });
  }
  cancelTurn(sessionId, turnId) {
    return this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/cancellations`, { clientIntentId: randomUUID() });
  }
  createSession(machineId, spawnSpecWire, creationIntentId = randomUUID()) {
    return this.call('POST', '/sessions', { mode: 'spawn', daemonId: machineId, creationIntentId, spawnSpec: spawnSpecWire });
  }
  /** Re-queue a spawn that failed (cwd missing), opting into creating it. */
  retrySpawn(id, createDir = true) { return this.call('POST', `/sessions/${encodeURIComponent(id)}/spawn/retry`, { createDir }); }
  deleteSession(id, ifStatus) {
    return this.call('DELETE', `/sessions/${encodeURIComponent(id)}${ifStatus ? `?ifStatus=${encodeURIComponent(ifStatus)}` : ''}`);
  }
  /** One sealed frame to a machine's daemon; the reply is a sealed frame. */
  tunnel(machineId, wire, { timeoutMs = 25_000 } = {}) {
    // Bounded: the relay holds a tunnel request up to 60 s for a daemon that
    // never answers, longer than an MCP client waits for a tool call.
    return this.call('POST', `/machines/${encodeURIComponent(machineId)}/http`, undefined, { raw: wire, timeoutMs });
  }

  // ── the doorbell ─────────────────────────────────────────────────────────
  /** Long-lived SSE. `onPoke(sessionId, changed)`, `onHello(sessions)`. Reconnects
   *  with backoff until `stop()` is called. */
  stream(handlers) {
    let stopped = false;
    let ctrl = null;
    const run = async () => {
      let backoff = 1000;
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await this.fetchImpl(`${this.relayUrl}/joy/v2/events/stream`, { headers: this.headers(), signal: ctrl.signal });
          if (res.status === 401 && this.renew) { this.token = await this.renew(); continue; }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          backoff = 1000;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          let buf = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
              let event = 'message'; const data = [];
              for (const line of frame.split(/\r?\n/)) {
                if (line.startsWith('event:')) event = line.slice(6).trim();
                else if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
              }
              if (!data.length) continue;
              let d; try { d = JSON.parse(data.join('\n')); } catch { continue; }
              try {
                if (event === 'hello') handlers.onHello?.(d.sessions ?? []);
                else if (event === 'ephemeral') handlers.onEphemeral?.(d.sessionId, d.turnId);
                else handlers.onPoke?.(d.sessionId ?? d.id, d.changed ?? []);
              } catch (e) { handlers.onError?.(e); }
            }
          }
        } catch (e) {
          if (!stopped) handlers.onError?.(e);
        }
        if (stopped) break;
        handlers.onClose?.();
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    };
    void run();
    return () => { stopped = true; ctrl?.abort(); };
  }
}
