// Wave D (review campaign 2026-09) — tunnel bounds and honest frame answers
// (#83, #84), reproduced against an in-process relay.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startRelay, sleep } from './harness.mjs';

let relay, base, tunnel, call, makeDaemon;

beforeAll(async () => {
  relay = await startRelay();
  ({ base, tunnel, call, makeDaemon } = relay);
});
afterAll(() => relay.close());

describe('#83 / #84 tunnel exchanges nobody awaits', () => {
  /** Mark the daemon attached (a poll within 35s) without consuming anything. */
  const attach = (d) => d.claim('tunnel', { waitMs: 10 });

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
