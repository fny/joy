// Direct mode: the extension talks to the daemon's own API over a WebRTC data
// channel. The relay carries only the setup (the offer and the answer, sealed
// in the tunnel — src/tunnel.js); prompts, answers and the session's history
// go peer to peer. The session is local-only: the daemon never announces it
// to the relay, and it does not appear on your phone.
//
// DirectClient has the RelayClient methods the background and the watcher
// use, mapped onto the daemon API, so everything above it works unchanged.
// Its events carry their payload already open ({ seq, payload }): nothing is
// sealed on a link that only the two ends can read.
//
// The channel speaks HTTP in JSON frames (transports/rtc.ts in the daemon):
//   → {t:'req', id, m, p, h, b?}  {t:'cancel', id}
//   ← {t:'head', id, s, h}  {t:'data', id, b}  {t:'end', id}  {t:'err', id, e}
import { b64, unb64, utf8, fromUtf8 } from './crypto.js';
import { tunnelKeyFor, tunnelJson } from './tunnel.js';
import { openPeer } from './peer.js';

/** STUN servers for the hole punch — the daemon uses the same default. */
export const DEFAULT_ICE = [{ urls: 'stun:stun.cloudflare.com:3478' }];
const HEAD = Number.MAX_SAFE_INTEGER; // ?after=HEAD: no history, just where it ends
const enc = encodeURIComponent;

export class DirectError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

/** Chrome: the peer lives in the offscreen document; this end drives it over
 *  a port (offscreen.js has the other half). Same contract as openPeer. */
export function offscreenPeerOpener(api) {
  let creating = null;
  const ensureDocument = async () => {
    const have = await api.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (have.length) return;
    creating ??= api.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WEB_RTC'], justification: 'Direct mode: a WebRTC data channel from this browser to your own machine' })
      .catch((e) => { if (!/single offscreen/i.test(e?.message ?? '')) throw e; })
      .finally(() => { creating = null; });
    await creating;
  };
  return async ({ iceServers, signal, onMessage, onClose }) => {
    await ensureDocument();
    return new Promise((resolve, reject) => {
      const port = api.runtime.connect({ name: 'joy-rtc' });
      let ready = false; let closed = false;
      const close = (why) => { if (closed) return; closed = true; try { port.disconnect(); } catch { /* gone */ } if (ready) onClose?.(why); else reject(new DirectError(why)); };
      port.onDisconnect.addListener(() => close('the direct connection closed'));
      port.onMessage.addListener(async (m) => {
        if (m?.type === 'offer') {
          try { port.postMessage({ type: 'answer', sdp: await signal(m.sdp) }); }
          catch (e) { try { port.postMessage({ type: 'fail', error: e?.message ?? String(e) }); } catch { /* gone */ } close(e?.message ?? String(e)); }
        } else if (m?.type === 'ready') {
          ready = true;
          resolve({ send: (data) => { if (!closed) port.postMessage({ type: 'msg', data }); }, close: () => close('closed') });
        } else if (m?.type === 'msg') onMessage?.(m.data);
        else if (m?.type === 'closed') close(m.reason ?? 'the direct connection closed');
      });
      port.postMessage({ type: 'open', iceServers });
    });
  };
}

/** The opener for this browser: in place where a page can hold the peer
 *  (Firefox's background page), the offscreen document otherwise (Chrome). */
export const peerOpenerFor = (api) => (typeof globalThis.RTCPeerConnection === 'function' ? openPeer : offscreenPeerOpener(api));

export class DirectClient {
  /** `relay` carries the setup (RelayClient.postTunnel); `machineKey` is the
   *  machine's key, from which both ends derive the tunnel key. */
  constructor({ relay, machineId, machineKey, openPeer: open, iceServers = DEFAULT_ICE }) {
    this.relay = relay; this.machineId = machineId; this.open = open; this.iceServers = iceServers;
    this.key = tunnelKeyFor(machineKey, machineId);
    this.peer = null; this.connecting = null; this.pending = new Map(); this.next = 0;
  }

  /** The open peer, connecting first when there is none. */
  async connect() {
    if (this.peer) return this.peer;
    this.connecting ??= (async () => {
      const link = {};
      const peer = await this.open({
        iceServers: this.iceServers,
        signal: (sdp) => this.#signal(sdp),
        onMessage: (text) => this.#frame(text),
        onClose: (why) => this.#closed(link, why),
      });
      link.peer = peer; this.peer = peer;
      return peer;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async #signal(offer) {
    const r = await tunnelJson((wire) => this.relay.postTunnel(this.machineId, wire), this.key, 'POST', '/v2/rtc/connect', { sdp: offer });
    if (r.status === 404) throw new DirectError('this machine\'s daemon is too old for Direct mode — update it, or use Relay mode', 404);
    if (r.status !== 200 || typeof r.json?.sdp !== 'string') throw new DirectError(`the machine refused the direct connection: ${r.json?.error ?? r.status}`, r.status);
    return r.json.sdp;
  }

  #closed(link, why) {
    if (this.peer && this.peer === link.peer) this.peer = null;
    for (const p of this.pending.values()) p.fail(why || 'the direct connection closed');
    this.pending.clear();
  }

  #frame(text) {
    let f; try { f = JSON.parse(text); } catch { return; }
    const p = this.pending.get(f?.id);
    if (!p) return;
    if (f.t === 'head') p.head(Number(f.s));
    else if (f.t === 'data') p.data(unb64(String(f.b ?? '')));
    else if (f.t === 'end') p.end();
    else if (f.t === 'err') p.fail(String(f.e ?? 'error'));
  }

  close() { this.peer?.close(); this.peer = null; }

  /** One HTTP exchange. Resolves { status, bytes }; with `onChunk` the body is
   *  handed over as it arrives instead (a following stream). */
  async request(method, path, body, { onChunk, signal } = {}) {
    const peer = await this.connect();
    const id = String(++this.next);
    return new Promise((resolve, reject) => {
      const chunks = []; let status = 0;
      const done = () => { this.pending.delete(id); signal?.removeEventListener('abort', abort); };
      const entry = {
        head: (s) => { status = s; },
        data: (u8) => { if (onChunk) onChunk(u8); else chunks.push(u8); },
        end: () => { done(); resolve({ status, bytes: concat(chunks) }); },
        fail: (e) => { done(); reject(new DirectError(e === 'bad_path' ? `the daemon refused the path ${path}` : e)); },
      };
      const abort = () => { try { peer.send(JSON.stringify({ t: 'cancel', id })); } catch { /* closed */ } entry.fail('cancelled'); };
      this.pending.set(id, entry);
      signal?.addEventListener('abort', abort, { once: true });
      const h = body === undefined ? {} : { 'content-type': 'application/json' };
      try { peer.send(JSON.stringify({ t: 'req', id, m: method, p: path, h, ...(body === undefined ? {} : { b: b64(utf8(JSON.stringify(body))) }) })); }
      catch (e) { entry.fail(e?.message ?? String(e)); }
    });
  }

  async call(method, path, body) {
    const { status, bytes } = await this.request(method, path, body);
    let json = null; try { json = JSON.parse(fromUtf8(bytes)); } catch { /* not json */ }
    if (status >= 400 || json?.error) throw new DirectError(json?.message ?? json?.error ?? `daemon ${status}`, status);
    return json;
  }

  /** NDJSON lines of a session's event log: [{ hello, seq }, ...records]. */
  async #eventLines(id, query) {
    const { status, bytes } = await this.request('GET', `/sessions/${enc(id)}/events?${query}`);
    if (status >= 400) {
      let error = `daemon ${status}`; try { error = JSON.parse(fromUtf8(bytes)).error ?? error; } catch { /* keep */ }
      throw new DirectError(error, status);
    }
    return fromUtf8(bytes).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  static #event = (r) => ({ seq: r.seq, payload: { t: 'record', record: r.record } });

  // ── the RelayClient surface ──────────────────────────────────────────────
  listSessions() { return this.call('GET', '/sessions').then((rows) => ({ sessions: rows ?? [] })); }
  /** A local-only session in `cwd`: nothing it does reaches the relay. */
  createSession(spec) { return this.call('POST', '/sessions', { ...spec, localOnly: true }); }
  async sessionState(id) {
    const [check, lines] = await Promise.all([this.call('GET', `/sessions/${enc(id)}/check`), this.#eventLines(id, `after=${HEAD}`)]);
    const headSeq = Number(lines[0]?.seq ?? 0);
    const busy = check?.state === 'busy' || check?.state === 'needs_input';
    return { headSeq, execution: { state: busy ? 'running' : 'idle' }, sessionState: check?.state === 'ended' ? 'archived' : 'active' };
  }
  async events(id, after) {
    const lines = await this.#eventLines(id, `after=${Number(after) || 0}`);
    return { messages: lines.slice(1).map(DirectClient.#event) };
  }
  async eventsBefore(id, before, limit = 80) {
    const lines = await this.#eventLines(id, `last=${Math.max(1, Number(limit) || 80)}`);
    return { messages: lines.slice(1).filter((r) => r.seq < before).map(DirectClient.#event) };
  }
  /** A prompt, plain: the channel is end-to-end already. */
  sendText(id, text, _key, _intent) { return this.call('POST', '/send', { session_id: id, text }); }

  /** The doorbell: follow the session's log and poke on every new record
   *  (and once per connect, for anything missed while away). */
  stream({ sessionId, onPoke, onError }) {
    let stopped = false; let ctl = null;
    const run = async () => {
      let backoff = 1000;
      while (!stopped) {
        ctl = new AbortController();
        let buf = ''; let hello = false;
        try {
          await this.request('GET', `/sessions/${enc(sessionId)}/events?after=${HEAD}&follow=1`, undefined, {
            signal: ctl.signal,
            onChunk: (u8) => {
              buf += fromUtf8(u8);
              let nl;
              while ((nl = buf.indexOf('\n')) >= 0) {
                buf = buf.slice(nl + 1);
                if (!hello) { hello = true; backoff = 1000; }
                onPoke?.(sessionId);
              }
            },
          });
        } catch (e) { if (!stopped) onError?.(e); }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 15_000);
      }
    };
    void run();
    return () => { stopped = true; ctl?.abort(); };
  }
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
