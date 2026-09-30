// The relay's account-side v2 API — the subset an attached browser needs.
// A port of packages/joy-mcp/src/relay.mjs: same routes, same renewal on 401
// (nobody is here to tap "sign in again"), fetch instead of node:crypto.
import { b64, signKeyPair, sign, randomBytes, sealText } from './crypto.js';

const CLIENT = 'joy-browser';

export class RelayError extends Error {
  constructor(status, code) { super(`relay ${status}: ${code}`); this.status = status; this.code = code; }
}

/** A typed relay address → the URL to use, or a reason it cannot be one.
 *  A bare host[:port] gets https://, the same rule as the app and `joy auth`. */
export function relayAddress(input) {
  const v = String(input ?? '').trim().replace(/\/+$/, '');
  if (!v) return { error: 'enter your relay\'s address' };
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  let u;
  try { u = new URL(url); } catch { return { error: `"${v}" is not an address — a relay looks like relay.example.com:4997` }; }
  if (u.pathname !== '/' || u.search || u.hash) return { error: `use just the host, without a path: ${u.origin}` };
  if (!u.hostname.includes('.') && u.hostname !== 'localhost' && !/^\[/.test(u.hostname)) return { error: `"${u.hostname}" is not a full address — a relay looks like relay.example.com:4997` };
  return { url: u.origin };
}

/** Is there a joy relay at `url`? Resolves null when there is, or one sentence
 *  saying what is there instead. A dead network is the common case, and the
 *  browsers' own words for it ("Load failed", "Failed to fetch") say nothing. */
export async function describeRelay(url, { perimeterKey, timeoutMs = 12_000 } = {}) {
  const headers = { 'x-joy-client': CLIENT };
  if (perimeterKey) headers['x-joy-relay-key'] = perimeterKey;
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let r;
  try { r = await fetch(`${url}/joy/v2/capabilities`, { headers, signal: ctl.signal }); }
  catch (e) {
    if (ctl.signal.aborted) return `${url} did not answer within ${Math.round(timeoutMs / 1000)} s`;
    return `could not reach ${url} (${e?.message ?? e}). Check the address — a relay is usually relay.example.com:4997 — and that this browser can open ${url}/joy/v2/capabilities`;
  } finally { clearTimeout(timer); }
  if (r.status === 401 || r.status === 403) return `${url} wants an access key this account does not have`;
  if (!r.ok) return `${url} answered ${r.status} — is it a joy relay?`;
  const caps = await r.json().catch(() => null);
  if (caps?.relay !== 'joy-relay') return `${url} is not a joy relay`;
  return null;
}

/** POST /auth — a signature over a self-chosen challenge. Returns the bearer. */
export async function loginWithSecret(relayUrl, accountSecret, { perimeterKey } = {}) {
  const kp = signKeyPair(accountSecret);
  const challenge = randomBytes(32);
  const headers = { 'content-type': 'application/json', 'x-joy-client': CLIENT };
  if (perimeterKey) headers['x-joy-relay-key'] = perimeterKey;
  const r = await fetch(`${relayUrl}/joy/v2/auth`, {
    method: 'POST', headers,
    body: JSON.stringify({ publicKey: b64(kp.publicKey), challenge: b64(challenge), signature: b64(sign(challenge, kp.secretKey)) }),
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json?.token) throw new RelayError(r.status, json?.error ?? 'login_failed');
  return String(json.token);
}

export class RelayClient {
  constructor({ relayUrl, token, perimeterKey = null, renew = null }) {
    this.relayUrl = relayUrl.replace(/\/+$/, '');
    this.token = token; this.perimeterKey = perimeterKey; this.renew = renew;
  }
  headers(extra = {}) {
    const h = { authorization: `Bearer ${this.token}`, 'x-joy-client': CLIENT, ...extra };
    if (this.perimeterKey) h['x-joy-relay-key'] = this.perimeterKey;
    return h;
  }
  async call(method, path, body, retryAuth = true) {
    const res = await fetch(`${this.relayUrl}/joy/v2${path}`, {
      method,
      headers: this.headers(body !== undefined ? { 'content-type': 'application/json' } : {}),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 401 && retryAuth && this.renew) {
      this.token = await this.renew();
      return this.call(method, path, body, false);
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new RelayError(res.status, json?.error ?? `http_${res.status}`);
    return json;
  }
  listSessions() { return this.call('GET', '/sessions'); }
  sessionState(id) { return this.call('GET', `/sessions/${encodeURIComponent(id)}`); }
  events(id, after, limit = 200) { return this.call('GET', `/sessions/${encodeURIComponent(id)}/events?after=${after}&limit=${limit}`); }
  /** The page of events ending just before `before` — history, newest last. */
  eventsBefore(id, before, limit = 80) { return this.call('GET', `/sessions/${encodeURIComponent(id)}/events?before=${before}&limit=${limit}`); }
  listMachines() { return this.call('GET', '/machines'); }
  /** Ask a machine's daemon to start a session: the spawn spec rides sealed (or plain) to it. */
  createSession(machineId, spawnSpecWire, creationIntentId = crypto.randomUUID()) {
    return this.call('POST', '/sessions', { mode: 'spawn', daemonId: machineId, creationIntentId, spawnSpec: spawnSpecWire });
  }
  /** Re-queue a spawn that failed for a missing folder, opting into creating it. */
  retrySpawn(id) { return this.call('POST', `/sessions/${encodeURIComponent(id)}/spawn/retry`, { createDir: true }); }
  /** The durable queue: a sealed prompt in, { messageId, turnId, seq } out. */
  sendCiphertext(sessionId, ciphertext, clientIntentId = crypto.randomUUID()) {
    return this.call('POST', `/sessions/${encodeURIComponent(sessionId)}/messages`, { ciphertext, clientIntentId });
  }
  /** A prompt in plain text: sealed here under the session key, then queued. */
  sendText(sessionId, text, key, clientIntentId) { return this.sendCiphertext(sessionId, sealText(text, key), clientIntentId); }

  /** Sealed bytes to a machine's daemon through the tunnel (src/tunnel.js
   *  seals and opens them). Resolves the raw answer: the daemon's sealed
   *  stream, or the relay's own JSON refusal. */
  async postTunnel(machineId, wire, retryAuth = true) {
    const res = await fetch(`${this.relayUrl}/joy/v2/machines/${encodeURIComponent(machineId)}/http`, {
      method: 'POST', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: wire,
    });
    if (res.status === 401 && retryAuth && this.renew) {
      this.token = await this.renew();
      return this.postTunnel(machineId, wire, false);
    }
    return { status: res.status, contentType: res.headers.get('content-type') ?? '', bytes: new Uint8Array(await res.arrayBuffer()) };
  }

  /** The doorbell: a long-lived SSE stream. `onPoke(sessionId)` says "something
   *  changed, re-read"; nothing is carried in it. Reconnects until stopped. */
  stream({ onPoke, onError }) {
    let stopped = false; let ctrl = null;
    const run = async () => {
      let backoff = 1000;
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await fetch(`${this.relayUrl}/joy/v2/events/stream`, { headers: this.headers(), signal: ctrl.signal });
          if (res.status === 401 && this.renew) { this.token = await this.renew(); continue; }
          if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
          backoff = 1000;
          const reader = res.body.getReader(); const decoder = new TextDecoder(); let buf = '';
          while (!stopped) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
              const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
              const data = frame.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart());
              if (!data.length) continue;
              let d; try { d = JSON.parse(data.join('\n')); } catch { continue; }
              if (d?.sessionId ?? d?.id) onPoke?.(d.sessionId ?? d.id);
            }
          }
        } catch (e) { if (!stopped) onError?.(e); }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    };
    void run();
    return () => { stopped = true; ctrl?.abort(); };
  }
}
