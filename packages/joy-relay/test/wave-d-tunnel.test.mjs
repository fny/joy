// Wave D (review campaign 2026-09) — tunnel bounds and honest frame answers
// (#83, #84), reproduced against an in-process relay; plus the follow-ups of
// the 2026-09-06 review of this lane: response-path backpressure, admission
// before the body is buffered, a relay-wide inbox budget, no parking for a
// closed client, quiet client aborts, lastPoll pruning and frame posts
// checked before their body is read. One relay, test-sized bounds.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as net from 'node:net';
import { EventEmitter } from 'node:events';
import { startRelay, sleep } from './harness.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createNotify } from '../src/notify.mjs';

const MIB = 1024 * 1024;
let relay, base, port, tunnel, call, makeDaemon;

beforeAll(async () => {
  relay = await startRelay({ tunnel: {
    responseMaxBuffered: 1 * MIB, responseDrainWaitMs: 300,
    globalMaxRequests: 20, globalMaxBytes: 4 * MIB,
  } });
  ({ base, tunnel, call, makeDaemon } = relay);
  port = new URL(base).port;
});
afterAll(() => relay.close());

/** Mark the daemon attached (a poll within 35s) without consuming anything. */
const attach = (d) => d.claim('tunnel', { waitMs: 10 });

describe('#83 / #84 tunnel exchanges nobody awaits', () => {
  it('#83 frames for a gone or foreign request are 4xx so the executor stops streaming', async () => {
    const d = makeDaemon('mach-83'); await d.acquire();
    const other = makeDaemon('mach-83-other', 'other-token'); await other.acquire();
    await attach(d);
    const ac = new AbortController();
    const clientReq = fetch(`${base}/joy/v2/machines/mach-83/http`, {
      method: 'POST', headers: { authorization: 'Bearer app-token' }, body: Buffer.from('sealed'), signal: ac.signal,
    }).catch(() => null);
    const [req] = await d.claim('tunnel', { waitMs: 2000 });
    expect(req.requestId).toBeTruthy();
    // A lease for another machine cannot answer.
    const foreign = await other.frames(req.requestId, Buffer.from('x'), false);
    expect(foreign.status).toBe(403);
    expect(foreign.json.error).toBe('wrong_daemon');
    // The owner answers a live request fine …
    expect((await d.frames(req.requestId, Buffer.from('head'), false)).status).toBe(200);
    // … the client leaves …
    ac.abort();
    await clientReq;
    await sleep(50);
    // … and the next frame post is a 404, not a 200 carrying {error}.
    const gone = await d.frames(req.requestId, Buffer.from('more'), false);
    expect(gone.status).toBe(404);
    expect(gone.json.error).toBe('request_gone');
  });

  it('#84 the inbox is bounded per daemon and a client that leaves takes its parked request with it', async () => {
    const d = makeDaemon('mach-84'); await d.acquire();
    await attach(d);
    const before = tunnel.stats();
    const controllers = [];
    const inflight = [];
    for (let i = 0; i < 16; i++) {
      const ac = new AbortController();
      controllers.push(ac);
      inflight.push(fetch(`${base}/joy/v2/machines/mach-84/http`, {
        method: 'POST', headers: { authorization: 'Bearer app-token' }, body: Buffer.from(`r${i}`), signal: ac.signal,
      }).catch(() => null));
    }
    // Wait until all 16 are parked.
    for (let i = 0; i < 50 && tunnel.stats().inboxRequests - before.inboxRequests < 16; i++) await sleep(20);
    expect(tunnel.stats().inboxRequests - before.inboxRequests).toBe(16);
    // The 17th is refused NOW rather than held.
    const busy = await call('POST', '/joy/v2/machines/mach-84/http', { raw: Buffer.from('r16') });
    expect(busy.status).toBe(503);
    expect(busy.json.error).toBe('daemon_busy');
    // Every waiting client leaves: their payloads leave the relay too, and
    // the daemon's next poll executes none of them.
    for (const ac of controllers) ac.abort();
    await Promise.all(inflight);
    for (let i = 0; i < 50 && tunnel.stats().inboxRequests !== before.inboxRequests; i++) await sleep(20);
    expect(tunnel.stats().inboxRequests).toBe(before.inboxRequests);
    expect(await d.claim('tunnel', { waitMs: 10 })).toEqual([]);
  });
});

/** A raw HTTP/1.1 request whose body can be left incomplete; resolves the
 *  response head as soon as it arrives (or null after `waitMs`). */
async function rawPost(path, headers, contentLength, sendBytes) {
  const s = net.connect(Number(port), '127.0.0.1');
  await new Promise((r) => s.on('connect', r));
  s.on('error', () => {});
  let got = '';
  s.on('data', (c) => { got += c; });
  const head = [`POST ${path} HTTP/1.1`, 'host: x', `content-length: ${contentLength}`, ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join('\r\n');
  s.write(head + '\r\n\r\n');
  if (sendBytes > 0) s.write(Buffer.alloc(sendBytes, 0x41));
  const response = async (waitMs = 1000) => {
    for (let i = 0; i < waitMs / 10 && !got.includes('\r\n\r\n'); i++) await sleep(10);
    if (!got.includes('\r\n\r\n')) return null;
    const [h, body] = got.split('\r\n\r\n');
    const status = Number(h.split(' ')[1]);
    const hdrs = Object.fromEntries(h.split('\r\n').slice(1).map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).toLowerCase(), l.slice(i + 1).trim()]; }));
    let json = null; try { json = JSON.parse(body.replace(/^[0-9a-f]+\r\n/i, '').split('\r\n')[0]); } catch { /* chunked or non-json */ }
    return { status, headers: hdrs, json, raw: got };
  };
  return { socket: s, response };
}

/** Park `n` tiny requests for `machine` (aborted by the returned fn). */
async function park(machine, n, before = tunnel.stats().inboxRequests) {
  const acs = [];
  for (let i = 0; i < n; i++) {
    const ac = new AbortController(); acs.push(ac);
    fetch(`${base}/joy/v2/machines/${machine}/http`, { method: 'POST', headers: { authorization: 'Bearer app-token' }, body: Buffer.from(`p${i}`), signal: ac.signal }).catch(() => null);
  }
  for (let i = 0; i < 100 && tunnel.stats().inboxRequests - before < n; i++) await sleep(10);
  expect(tunnel.stats().inboxRequests - before).toBe(n);
  return async () => { for (const ac of acs) ac.abort(); for (let i = 0; i < 100 && tunnel.stats().inboxRequests !== before; i++) await sleep(10); };
}

describe('(1) response path is bounded: a stalled client paces, then loses, the daemon', () => {
  it('a client that stops reading gets dropped as client_slow after the drain deadline; the next post is request_gone', async () => {
    const d = makeDaemon('mach-f1'); await d.acquire(); await attach(d);
    const { socket } = await rawPost('/joy/v2/machines/mach-f1/http', { authorization: 'Bearer app-token' }, 6, 6);
    socket.pause(); // never read the response
    let closed = false; socket.on('close', () => { closed = true; });
    const [req] = await d.claim('tunnel', { waitMs: 2000 });
    let last = null; let accepted = 0; let waitedMs = 0;
    for (let i = 0; i < 64; i++) {
      const t0 = Date.now();
      last = await d.frames(req.requestId, Buffer.alloc(MIB, i), false);
      if (last.status !== 200) { waitedMs = Date.now() - t0; break; }
      accepted++;
    }
    expect(last.status).toBe(429);
    expect(last.json.error).toBe('client_slow');
    expect(accepted).toBeLessThan(64);                 // never unbounded
    expect(waitedMs).toBeGreaterThanOrEqual(250);      // the refusing post honoured the drain deadline first
    expect((await d.frames(req.requestId, Buffer.from('x'), false)).status).toBe(404); // dropped
    // The stream was destroyed under the client: once it reads again it sees
    // the socket close (truncation for its SealedReader), never a clean end.
    socket.resume();
    for (let i = 0; i < 100 && !closed; i++) await sleep(10);
    expect(closed).toBe(true);
    expect(tunnel.stats().pending).toBe(0);
  });

  it('a slow-but-alive client that keeps reading receives every byte — the daemon is paced, not dropped', async () => {
    const d = makeDaemon('mach-f1b'); await d.acquire(); await attach(d);
    const client = fetch(`${base}/joy/v2/machines/mach-f1b/http`, { method: 'POST', headers: { authorization: 'Bearer app-token' }, body: Buffer.from('r') });
    const [req] = await d.claim('tunnel', { waitMs: 2000 });
    const N = 6;
    const posts = (async () => { for (let i = 0; i < N; i++) expect((await d.frames(req.requestId, Buffer.alloc(MIB, i), false)).status).toBe(200); return d.frames(req.requestId, Buffer.alloc(0), true); })();
    const res = await client;
    expect(res.status).toBe(200);
    const body = Buffer.from(await res.arrayBuffer());
    expect((await posts).status).toBe(200);
    expect(body.length).toBe(N * MIB);
    for (let i = 0; i < N; i++) expect(body[i * MIB]).toBe(i);
  });
});

describe('(2) admission happens before the body is buffered', () => {
  it('an offline daemon is refused while the upload is still in flight', async () => {
    const d = makeDaemon('mach-f2-off'); await d.acquire(); // owned, never polled
    const before = tunnel.stats();
    const r = await rawPost('/joy/v2/machines/mach-f2-off/http', { authorization: 'Bearer app-token' }, MIB + 1, MIB);
    const resp = await r.response(1000);
    expect(resp?.status).toBe(503);
    expect(resp.json.error).toBe('daemon_offline');
    expect(tunnel.stats().reservedRequests).toBe(before.reservedRequests);
    r.socket.destroy();
  });

  it('a declared size over the cap is a 413 before any byte is read', async () => {
    const d = makeDaemon('mach-f2-big'); await d.acquire(); await attach(d);
    const r = await rawPost('/joy/v2/machines/mach-f2-big/http', { authorization: 'Bearer app-token' }, 33 * MIB, 0);
    const resp = await r.response(1000);
    expect(resp?.status).toBe(413);
    expect(resp.json.error).toBe('body_too_large');
    r.socket.destroy();
  });

  it('a full inbox refuses the next upload immediately, and in-flight uploads count against the inbox', async () => {
    const d = makeDaemon('mach-f2-full'); await d.acquire(); await attach(d);
    const release = await park('mach-f2-full', 16);
    const r = await rawPost('/joy/v2/machines/mach-f2-full/http', { authorization: 'Bearer app-token' }, MIB + 1, MIB);
    const resp = await r.response(1000);
    expect(resp?.status).toBe(503);
    expect(resp.json.error).toBe('daemon_busy');
    expect(resp.headers['retry-after']).toBe('1');
    r.socket.destroy();
    await release();
    // Reservations: 16 uploads that never finish fill the inbox by themselves.
    const inflight = [];
    for (let i = 0; i < 16; i++) inflight.push(await rawPost('/joy/v2/machines/mach-f2-full/http', { authorization: 'Bearer app-token' }, 1000, 10));
    for (let i = 0; i < 100 && tunnel.stats().reservedRequests < 16; i++) await sleep(10);
    expect(tunnel.stats().reservedRequests).toBe(16);
    expect(tunnel.stats().inboxRequests).toBe(0); // nothing parked — nothing buffered
    const busy = await call('POST', '/joy/v2/machines/mach-f2-full/http', { raw: Buffer.from('r17') });
    expect(busy.status).toBe(503);
    expect(busy.json.error).toBe('daemon_busy');
    for (const x of inflight) x.socket.destroy();
    for (let i = 0; i < 100 && tunnel.stats().reservedRequests !== 0; i++) await sleep(10);
    expect(tunnel.stats().reservedRequests).toBe(0); // aborted uploads release their reservation
  });
});

describe('(3) a relay-wide inbox budget sits above the per-daemon caps', () => {
  it('two daemons under their own caps still hit relay_busy together', async () => {
    const a = makeDaemon('mach-f3a'); await a.acquire(); await attach(a);
    const b = makeDaemon('mach-f3b'); await b.acquire(); await attach(b);
    const relA = await park('mach-f3a', 12);
    const relB = await park('mach-f3b', 8); // 20 total = globalMaxRequests
    const r = await call('POST', '/joy/v2/machines/mach-f3b/http', { raw: Buffer.from('x') });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('relay_busy');
    expect(r.headers.get('retry-after')).toBe('1');
    await relB();
    expect((await park('mach-f3b', 1)) && tunnel.stats().inboxRequests).toBe(13); // room again once others leave
    await relA();
    for (let i = 0; i < 100 && tunnel.stats().inboxRequests !== 1; i++) await sleep(10);
  });
});

describe('(5) a request whose client already left is never parked', () => {
  it('clientRequest on a destroyed response parks nothing and wakes nobody', async () => {
    const d = makeDaemon('mach-f5'); await d.acquire(); await attach(d);
    const before = tunnel.stats();
    const res = new EventEmitter();
    Object.assign(res, { destroyed: true, headersSent: false, writeHead() {}, end() {}, destroy() {} });
    tunnel.clientRequest('mach-f5', Buffer.from('kill'), res);
    expect(tunnel.stats().pending).toBe(before.pending);
    expect(tunnel.stats().inboxRequests).toBe(before.inboxRequests);
    expect(await d.claim('tunnel', { waitMs: 10 })).toEqual([]);
  });
});

describe('(6) a client abort mid-body is an early exit, not an internal error', () => {
  it('logs no stack trace and releases the admission reservation', async () => {
    const d = makeDaemon('mach-f6'); await d.acquire(); await attach(d);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await rawPost('/joy/v2/machines/mach-f6/http', { authorization: 'Bearer app-token' }, MIB, 1000);
      for (let i = 0; i < 100 && tunnel.stats().reservedRequests < 1; i++) await sleep(10);
      expect(tunnel.stats().reservedRequests).toBe(1);
      r.socket.destroy();
      for (let i = 0; i < 100 && tunnel.stats().reservedRequests !== 0; i++) await sleep(10);
      expect(tunnel.stats().reservedRequests).toBe(0);
      expect(errors.mock.calls.filter((c) => String(c[0]).includes('internal error'))).toEqual([]);
    } finally { errors.mockRestore(); }
  });
});

describe('(7) housekeeping: lastPoll ages out; frame posts are checked before their body', () => {
  it('a frame post for an unknown request is refused before its body arrives', async () => {
    const d = makeDaemon('mach-f7'); await d.acquire(); await attach(d);
    const r = await rawPost('/joy/v2/daemon/tunnel/00000000-0000-4000-8000-000000000000/frames',
      { 'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'content-type': 'application/octet-stream' }, MIB + 1, MIB);
    const resp = await r.response(1000);
    expect(resp?.status).toBe(404);
    expect(resp.json.error).toBe('request_gone');
    r.socket.destroy();
  });

  it('daemons that stopped polling leave the attach map by age', async () => {
    // Pure attach-map logic: a bare tunnel with its own clock, no database.
    let t = 1_000_000;
    const own = createTunnel({ notify: createNotify(), now: () => t });
    await own.claim('mach-f7x', 1);
    await own.claim('mach-f7y', 1);
    expect(own.stats().trackedDaemons).toBe(2);
    t += 36_000; // past ATTACH_FRESH_MS
    await own.claim('mach-f7y', 1); // y is back; x never returned
    expect(own.attached('mach-f7x')).toBe(false);
    expect(own.attached('mach-f7y')).toBe(true);
    expect(own.stats().trackedDaemons).toBe(1);
  });
});

describe('(8) #84 a parked request outlives neither its client nor the idle deadline', () => {
  /** A client response the tunnel can answer: records the head and body,
   *  never drains (no socket), and reports `destroyed` like a real one. */
  function clientRes() {
    const res = new EventEmitter();
    Object.assign(res, {
      destroyed: false, writableEnded: false, headersSent: false, status: null, headers: null, body: '',
      writeHead(status, headers) { res.headersSent = true; res.status = status; res.headers = headers; },
      write() { return true; },
      end(body) { res.writableEnded = true; if (body) res.body += body; },
      destroy() { res.destroyed = true; res.emit('close'); },
    });
    return res;
  }

  it('a daemon that attached and then died never collects the request: the client hears 504 and the inbox is empty again', async () => {
    const own = createTunnel({ notify: createNotify(), responseIdleMs: 120 });
    await own.claim('mach-f8', 1); // attached — and never polls again
    const res = clientRes();
    own.clientRequest('mach-f8', Buffer.alloc(64 * 1024, 0x42), res);
    expect(own.stats()).toMatchObject({ pending: 1, inboxRequests: 1, inboxBytes: 64 * 1024 });
    await sleep(50);
    expect(own.stats().inboxRequests).toBe(1); // still parked inside the deadline
    for (let i = 0; i < 100 && own.stats().inboxRequests !== 0; i++) await sleep(10);
    // Failed AND dequeued: nothing outlives the idle deadline in relay memory.
    expect(own.stats()).toMatchObject({ pending: 0, inboxRequests: 0, inboxBytes: 0 });
    expect(res.status).toBe(504);
    expect(JSON.parse(res.body).error).toBe('daemon_response_timeout');
    // The daemon coming back (or a re-paired machine under the same id) is
    // handed nothing — it must never execute a request nobody awaits.
    expect((await own.claim('mach-f8', 1)).requests).toEqual([]);
  });
});
