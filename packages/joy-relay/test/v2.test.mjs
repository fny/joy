// e2e for the ADDITIVE /joy/v2 surface: real HTTP server, real PGlite,
// fake app + fake daemon driving both planes through v2 paths only.
// v1 stays mounted beside it (native.test.mjs proves it unchanged).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createV2Router } from '../src/v2.mjs';
import { createTunnel } from '../src/tunnel.mjs';
import { createAttachments } from '../src/attachments.mjs';

const TOKENS = new Map([['app-token', 'account-1'], ['other-token', 'account-2']]);

let server, base, db, core, notify;

beforeAll(async () => {
  db = await openDb(':memory:');
  notify = createNotify();
  core = createCore(db, notify);
  const auth = { verifyToken: async (t) => TOKENS.get(t) ?? null };
  const tunnel = createTunnel({ notify });
  const attachments = createAttachments(db);
  const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments });
  server = http.createServer(async (req, res) => {
    if (await v2.handle(req, res)) return;
    res.writeHead(599); res.end('would-passthrough');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.close();
  await db.close();
});

async function call(method, path, { body, token = 'app-token', headers = {}, raw } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: raw !== undefined
      ? { authorization: `Bearer ${token}`, ...headers }
      : { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: raw !== undefined ? raw : (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  return { status: r.status, json, text, headers: r.headers };
}

/** Fake daemon speaking ONLY v2 daemon paths. */
function makeDaemon(daemonId) {
  const d = { daemonId, leaseId: null, token: null, epoch: null };
  d.headers = () => ({
    'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'x-joy-lease-epoch': d.epoch,
  });
  d.acquire = async () => {
    const { status, json } = await call('POST', '/joy/v2/daemon/leases', { body: { machineId: daemonId } });
    expect(status).toBe(200);
    d.leaseId = json.leaseId; d.token = json.leaseToken; d.epoch = json.epoch;
    return json;
  };
  d.claim = async (lane) => {
    const { status, json } = await call('POST', `/joy/v2/daemon/leases/${d.leaseId}/claims/${lane}`, {
      body: { noWait: true }, headers: { 'x-joy-lease-token': d.token },
    });
    expect(status).toBe(200);
    return json.offers;
  };
  d.received = (deliveryId) => call('POST', `/joy/v2/daemon/deliveries/${deliveryId}/received`, { headers: d.headers() });
  d.submitted = (turnId) => call('POST', `/joy/v2/daemon/turns/${turnId}/submitted`, { headers: d.headers() });
  d.start = (turnId, body = {}) => call('POST', `/joy/v2/daemon/turns/${turnId}/start`, { body, headers: d.headers() });
  d.fact = (turnId, body) => call('POST', `/joy/v2/daemon/turns/${turnId}/facts`, { body, headers: d.headers() });
  d.reconcile = (turnId, body) => call('POST', `/joy/v2/daemon/turns/${turnId}/reconcile`, { body, headers: d.headers() });
  d.bind = (sessionId, body) => call('POST', `/joy/v2/daemon/sessions/${sessionId}/bind`, { body, headers: d.headers() });
  return d;
}

async function makeSession(daemon) {
  const { status, json } = await call('POST', '/joy/v2/sessions', {
    body: {
      mode: 'announce_existing', creationIntentId: randomUUID(), daemonId: daemon.daemonId,
      localSessionId: randomUUID().slice(0, 8), sessionKeyEnvelope: 'wrapped-key',
    },
  });
  expect(status).toBe(200);
  return json.sessionId;
}

/** Drive one message from queued to delivered through the daemon lane. */
async function deliverHead(d, sessionId) {
  const offers = await d.claim('work');
  const offer = offers.find((o) => o.sessionId === sessionId && o.kind === 'prompt');
  expect(offer).toBeTruthy();
  expect((await d.received(offer.deliveryId)).status).toBe(200);
  expect((await d.submitted(offer.turnId)).status).toBe(200);
  expect((await d.start(offer.turnId, { runtimeEventId: randomUUID() })).status).toBe(200);
  return offer;
}

describe('v2 sessions + messages lifecycle', () => {
  it('full path: create, queue offline, deliver, terminal — status transitions observed', async () => {
    const d = makeDaemon('mach-life');
    await d.acquire();
    const sessionId = await makeSession(d);
    await d.bind(sessionId, { localSessionId: 'w1', sessionKeyEnvelope: 'wrapped-key' });

    // Queue a message. Nothing has claimed yet: status must be queued.
    const post = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'c1' } });
    expect(post.status).toBe(202);
    const { messageId, turnId } = post.json;
    let msg = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${messageId}`);
    expect(msg.json.status).toBe('queued');

    // Claim + ack: the daemon now HOLDS the payload — the message must stop
    // reading as queued (editable) the moment the ack lands.
    const offers = await d.claim('work');
    const offer = offers.find((o) => o.sessionId === sessionId);
    await d.received(offer.deliveryId);
    msg = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${messageId}`);
    expect(msg.json.status).toBe('delivering');

    // Submitted → dispatching → "delivering".
    await d.submitted(turnId);
    msg = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${messageId}`);
    expect(msg.json.status).toBe('delivering');

    // Started → running → "delivered".
    expect((await d.start(turnId, { runtimeEventId: randomUUID() })).status).toBe(200);
    msg = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${messageId}`);
    expect(msg.json.status).toBe('delivered');

    // Terminal completed keeps "delivered"; turn read shows terminal.
    expect((await d.fact(turnId, { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() })).status).toBe(200);
    msg = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${messageId}`);
    expect(msg.json.status).toBe('delivered');
    const turn = await call('GET', `/joy/v2/sessions/${sessionId}/turns/${turnId}`);
    expect(turn.json.state).toBe('terminal');
    expect(turn.json.terminalState).toBe('completed');
    expect(turn.json.messageId).toBe(messageId);
  });

  it('list + status filter; foreign account sees nothing', async () => {
    const d = makeDaemon('mach-list');
    await d.acquire();
    const sessionId = await makeSession(d);
    await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'a' } });
    await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'b' } });
    const all = await call('GET', `/joy/v2/sessions/${sessionId}/messages`);
    expect(all.json.messages.length).toBe(2);
    const queued = await call('GET', `/joy/v2/sessions/${sessionId}/messages?status=queued`);
    expect(queued.json.messages.length).toBe(2);
    const delivered = await call('GET', `/joy/v2/sessions/${sessionId}/messages?status=delivered`);
    expect(delivered.json.messages.length).toBe(0);
    const foreign = await call('GET', `/joy/v2/sessions/${sessionId}/messages`, { token: 'other-token' });
    expect(foreign.status).toBe(404);
  });

  it('PATCH edits + reorders while queued; 409 after delivery starts', async () => {
    const d = makeDaemon('mach-edit');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'first' } })).json;
    const m2 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'second' } })).json;

    const evBefore = (await call('GET', `/joy/v2/sessions/${sessionId}/events`)).json.messages.length;
    const edited = await call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`, { body: { ciphertext: 'first-edited' } });
    expect(edited.status).toBe(200);
    expect(edited.json.ciphertext).toBe('first-edited');
    // The edit is durable: a replaying device must see it, not the original.
    const evAfter = (await call('GET', `/joy/v2/sessions/${sessionId}/events`)).json.messages;
    expect(evAfter.length).toBe(evBefore + 1);
    expect(evAfter.at(-1).kind).toBe('message.edited');
    expect(evAfter.at(-1).content.ciphertext).toBe('first-edited');

    // position must be a non-negative integer index — nothing else moves rows.
    for (const bad of ['zzz', -1, 1.5]) {
      const r = await call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`, { body: { position: bad } });
      expect(r.status).toBe(400);
    }

    // Move the second message to the head.
    const moved = await call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${m2.messageId}`, { body: { position: 0 } });
    expect(moved.status).toBe(200);
    const list = await call('GET', `/joy/v2/sessions/${sessionId}/messages`);
    expect(list.json.messages.map((x) => x.id)).toEqual([m2.messageId, m1.messageId]);

    // Deliver the (new) head; then editing it must 409.
    const offer = await deliverHead(d, sessionId);
    expect(offer.commandId).toBe(m2.messageId);
    const late = await call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${m2.messageId}`, { body: { ciphertext: 'nope' } });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe('not_editable');
  });

  it('DELETE cancels a queued message; refuses once delivering', async () => {
    const d = makeDaemon('mach-del');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'kill-me' } })).json;
    const gone = await call('DELETE', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`);
    expect(gone.status).toBe(200);
    expect(gone.json.disposition).toBe('cancelled_before_start');
    const after = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`);
    expect(after.json.status).toBe('cancelled');

    const m2 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'running' } })).json;
    await deliverHead(d, sessionId);
    const refused = await call('DELETE', `/joy/v2/sessions/${sessionId}/messages/${m2.messageId}`);
    expect(refused.status).toBe(409);
  });

  it('cancellation precondition: wrong turnId answers 409 with activeTurnId', async () => {
    const d = makeDaemon('mach-cxl');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'active' } })).json;
    await deliverHead(d, sessionId);
    const wrong = await call('POST', `/joy/v2/sessions/${sessionId}/turns/${randomUUID()}/cancellations`, { body: {} });
    expect(wrong.status).toBe(409);
    expect(wrong.json.error).toBe('different_turn_active');
    expect(wrong.json.activeTurnId).toBe(m1.turnId);
    const right = await call('POST', `/joy/v2/sessions/${sessionId}/turns/${m1.turnId}/cancellations`, { body: {} });
    expect(right.status).toBe(200);
    expect(right.json.disposition).toBe('cancellation_requested');
  });
});

describe('v2 send idempotency', () => {
  it('capabilities probe answers without auth', async () => {
    const r = await fetch(`${base}/joy/v2/capabilities`);
    expect(r.status).toBe(200);
    expect((await r.json()).relay).toBe('joy-relay');
  });

  it('same clientIntentId replays the first acceptance even when the (re-sealed) ciphertext differs', async () => {
    const d = makeDaemon('mach-idem');
    await d.acquire();
    const sessionId = await makeSession(d);
    await d.bind(sessionId, { localSessionId: 'w1', sessionKeyEnvelope: 'wrapped-key' });
    const clientIntentId = randomUUID();
    const first = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { clientIntentId, ciphertext: 'v2e1:nonceA' } });
    expect(first.status).toBe(202);
    // A retry re-seals under a fresh nonce: different bytes, same intent —
    // the relay must answer with the SAME message, never a second turn.
    const retry = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { clientIntentId, ciphertext: 'v2e1:nonceB' } });
    expect(retry.status).toBe(202);
    expect(retry.json.messageId).toBe(first.json.messageId);
    expect(retry.json.turnId).toBe(first.json.turnId);
    const list = await call('GET', `/joy/v2/sessions/${sessionId}/messages`);
    expect(list.json.messages.filter((m) => m.id === first.json.messageId).length).toBe(1);
    expect(list.json.messages.length).toBe(1);
    // A retry that ALSO re-uploaded its attachment cites a different id; the
    // replay ignores the outer list (nothing to reference twice).
    const bytes = Buffer.from('sealed-bytes-retry');
    const up = await call('POST', '/joy/v2/attachments', { raw: bytes, headers: { 'x-session': sessionId } });
    const again = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { clientIntentId, ciphertext: 'v2e1:nonceC', attachments: [up.json.attachmentId] } });
    expect(again.status).toBe(202);
    expect(again.json.messageId).toBe(first.json.messageId);
  });

  it('attachment reference + claim commit with the message: an unknown id rejects the whole send', async () => {
    const d = makeDaemon('mach-atomic');
    await d.acquire();
    const sessionId = await makeSession(d);
    await d.bind(sessionId, { localSessionId: 'w1', sessionKeyEnvelope: 'wrapped-key' });
    const bad = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'x', attachments: [randomUUID()] } });
    expect(bad.status).toBe(422);
    expect((await call('GET', `/joy/v2/sessions/${sessionId}/messages`)).json.messages.length).toBe(0);
  });
});

describe('v2 session key re-envelope', () => {
  it('the owning daemon can replace sessionKeyEnvelope via PATCH; others cannot', async () => {
    const d = makeDaemon('mach-reenv');
    await d.acquire();
    const sessionId = await makeSession(d);
    await d.bind(sessionId, { localSessionId: 'w1', sessionKeyEnvelope: 'v2sk1:old' });
    const r = await call('PATCH', `/joy/v2/daemon/sessions/${sessionId}`, { body: { sessionKeyEnvelope: 'v2sk1:new' }, headers: d.headers() });
    expect(r.status).toBe(200);
    const row = (await call('GET', '/joy/v2/sessions')).json.sessions.find((s) => s.sessionId === sessionId);
    expect(row.sessionKeyEnvelope).toBe('v2sk1:new');
    const other = makeDaemon('mach-reenv-other'); await other.acquire();
    expect((await call('PATCH', `/joy/v2/daemon/sessions/${sessionId}`, { body: { sessionKeyEnvelope: 'v2sk1:evil' }, headers: other.headers() })).status).toBe(403);
    expect((await call('PATCH', `/joy/v2/daemon/sessions/${sessionId}`, { body: { sessionKeyEnvelope: 5 }, headers: d.headers() })).status).toBe(400);
  });
});

describe('v2 session-scoped output facts', () => {
  it('lease-fenced, replay-idempotent, visible in the event log with no turn', async () => {
    const d = makeDaemon('mach-sfact');
    await d.acquire();
    const sessionId = await makeSession(d);
    await d.bind(sessionId, { localSessionId: 'w1', sessionKeyEnvelope: 'wrapped-key' });
    const post = (body, headers = d.headers()) => call('POST', `/joy/v2/daemon/sessions/${sessionId}/facts`, { body, headers });
    const a = await post({ type: 'output', ciphertext: 'rec-1', runtimeEventId: 'rec:1' });
    expect(a.status).toBe(200);
    const again = await post({ type: 'output', ciphertext: 'rec-1', runtimeEventId: 'rec:1' });
    expect(again.json.replay).toBe(true);
    expect((await post({ type: 'terminal' })).status).toBe(400);
    const other = makeDaemon('mach-other'); await other.acquire();
    expect((await post({ type: 'output', ciphertext: 'x' }, other.headers())).status).toBe(403);
    const ev = (await call('GET', `/joy/v2/sessions/${sessionId}/events?after=0&limit=50`)).json.messages;
    const out = ev.filter((e) => e.kind === 'output');
    expect(out.length).toBe(1);
    expect(out[0].turnId).toBeNull();
    expect(out[0].content.ciphertext).toBe('rec-1');
  });
});

describe('v2 retry (orphaned only)', () => {
  it('lease death orphans the turn; message reads failed+mayHaveDelivered; retry requeues and re-offers', async () => {
    const d = makeDaemon('mach-orphan');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'doomed' } })).json;
    await deliverHead(d, sessionId);

    // Not retryable while running.
    const early = await call('POST', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}/retry`);
    expect(early.status).toBe(409);

    // Kill the lease; the sweep orphans the running turn.
    await db.query(`UPDATE daemon_leases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [d.leaseId]);
    await core.sweepExpiredLeases();
    const failed = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`);
    expect(failed.json.status).toBe('failed');
    expect(failed.json.failure.retryable).toBe(true);
    expect(failed.json.failure.mayHaveDelivered).toBe(true);

    // Retry re-queues the SAME message; a fresh lease claims it again.
    const retried = await call('POST', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.json.messageId).toBe(m1.messageId);
    const again = await call('GET', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`);
    expect(again.json.status).toBe('queued');

    // Lost-ack: retrying an already-requeued message replays 202, never 409.
    const replay = await call('POST', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}/retry`);
    expect(replay.status).toBe(202);
    expect(replay.json.replay).toBe(true);

    await d.acquire(); // new lease, new epoch
    const offers = await d.claim('work');
    const offer = offers.find((o) => o.sessionId === sessionId);
    expect(offer).toBeTruthy();
    expect(offer.commandId).toBe(m1.messageId);
  });
});

describe('v2 attachment reference reaches the daemon', () => {
  const bytes = Buffer.from('device-born-bytes-for-offer');
  it('work-lane offer carries cited attachment ids + sizes', async () => {
    const d = makeDaemon('mach-att-offer');
    await d.acquire();
    const sessionId = await makeSession(d);
    await d.bind(sessionId, { localSessionId: 'w1', sessionKeyEnvelope: 'wrapped-key' });
    const up = await call('POST', '/joy/v2/attachments', { raw: bytes, headers: { 'x-session': sessionId } });
    const attachmentId = up.json.attachmentId;
    const posted = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, {
      body: { ciphertext: 'see attached', attachments: [attachmentId] },
    });
    expect(posted.status).toBe(202);
    const offers = await d.claim('work');
    const offer = offers.find((o) => o.sessionId === sessionId && o.kind === 'prompt');
    expect(offer).toBeTruthy();
    expect(offer.attachments).toEqual([{ id: attachmentId, size: bytes.length }]);
  });
});

describe('v2 attachments (device-born, sealed)', () => {
  const bytes = Buffer.from('sealed-attachment-bytes-v2');
  const hash = createHash('sha256').update(bytes).digest('hex');

  it('upload, dedupe, fetch-immutable, reference validation, purge cascade', async () => {
    const d = makeDaemon('mach-att');
    await d.acquire();
    const sessionId = await makeSession(d);

    // Upload → 201; identical retry → 200 with the SAME id.
    const up1 = await call('POST', '/joy/v2/attachments', {
      raw: bytes, headers: { 'x-session': sessionId, 'x-cipher-hash': hash },
    });
    expect(up1.status).toBe(201);
    const attachmentId = up1.json.attachmentId;
    expect(up1.json.size).toBe(bytes.length);
    const up2 = await call('POST', '/joy/v2/attachments', {
      raw: bytes, headers: { 'x-session': sessionId, 'x-cipher-hash': hash },
    });
    expect(up2.status).toBe(200);
    expect(up2.json.attachmentId).toBe(attachmentId);

    // Declared hash must match the bytes.
    const lied = await call('POST', '/joy/v2/attachments', {
      raw: Buffer.from('other-bytes'), headers: { 'x-session': sessionId, 'x-cipher-hash': hash },
    });
    expect(lied.status).toBe(400);

    // Fetch: bytes + immutable caching; foreign account gets 404.
    const got = await call('GET', `/joy/v2/attachments/${attachmentId}`);
    expect(got.status).toBe(200);
    expect(got.text).toBe(bytes.toString());
    expect(got.headers.get('cache-control')).toContain('immutable');
    expect((await call('GET', `/joy/v2/attachments/${attachmentId}`, { token: 'other-token' })).status).toBe(404);

    // Message citing an unknown attachment → 422 and NOTHING queued.
    const bad = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, {
      body: { ciphertext: 'img', attachments: [randomUUID()] },
    });
    expect(bad.status).toBe(422);
    expect((await call('GET', `/joy/v2/sessions/${sessionId}/messages`)).json.messages.length).toBe(0);

    // Valid reference → 202; purge cascades the attachment away.
    const ok = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, {
      body: { ciphertext: 'img', attachments: [attachmentId] },
    });
    expect(ok.status).toBe(202);
    expect((await call('DELETE', `/joy/v2/sessions/${sessionId}`)).status).toBe(200);
    expect((await call('GET', `/joy/v2/attachments/${attachmentId}`)).status).toBe(404);
    expect((await call('GET', `/joy/v2/sessions/${sessionId}`)).status).toBe(404);
  });

  it('upload against a foreign session is refused', async () => {
    const d = makeDaemon('mach-att2');
    await d.acquire();
    const sessionId = await makeSession(d);
    const stolen = await call('POST', '/joy/v2/attachments', {
      raw: bytes, headers: { 'x-session': sessionId, 'x-cipher-hash': hash }, token: 'other-token',
    });
    expect(stolen.status).toBe(403);
  });
});

describe('v2 ephemeral lane', () => {
  it('ephemeral output reaches SSE but never the durable event log', async () => {
    const d = makeDaemon('mach-eph');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'stream-me' } })).json;
    await deliverHead(d, sessionId);

    // Open the v2 SSE stream and collect frames.
    const ac = new AbortController();
    const sse = await fetch(`${base}/joy/v2/events/stream`, {
      headers: { authorization: 'Bearer app-token' }, signal: ac.signal,
    });
    expect(sse.status).toBe(200);
    const reader = sse.body.getReader();
    let buf = '';
    const readUntil = async (marker, ms = 3000) => {
      const deadline = Date.now() + ms;
      while (!buf.includes(marker)) {
        if (Date.now() > deadline) throw new Error(`SSE timeout waiting for ${marker}; got: ${buf}`);
        const { value, done } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString();
      }
    };
    await readUntil('event: hello');

    const headBefore = (await call('GET', `/joy/v2/sessions/${sessionId}/events`)).json.messages.length;
    const eph = await d.fact(m1.turnId, { type: 'output', ephemeral: true, ciphertext: 'delta-1' });
    expect(eph.status).toBe(200);
    expect(eph.json.ephemeral).toBe(true);
    await readUntil('event: ephemeral');
    expect(buf).toContain('delta-1');
    ac.abort();

    // Durable log unchanged by the ephemeral fact; a durable output still lands.
    const headAfter = (await call('GET', `/joy/v2/sessions/${sessionId}/events`)).json.messages.length;
    expect(headAfter).toBe(headBefore);
    await d.fact(m1.turnId, { type: 'output', ciphertext: 'block-1', runtimeEventId: randomUUID() });
    const final = (await call('GET', `/joy/v2/sessions/${sessionId}/events`)).json.messages;
    expect(final.length).toBe(headBefore + 1);
    expect(final.at(-1).content.ciphertext).toBe('block-1');
  });

  it('ephemeral fact with a stale epoch is fenced out', async () => {
    const d = makeDaemon('mach-eph2');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'x' } })).json;
    await deliverHead(d, sessionId);
    const zombie = { ...d.headers(), 'x-joy-lease-epoch': String(Number(d.epoch) - 1) };
    const r = await call('POST', `/joy/v2/daemon/turns/${m1.turnId}/facts`, {
      body: { type: 'output', ephemeral: true, ciphertext: 'zombie-delta' }, headers: zombie,
    });
    expect(r.status).toBe(412);
  });
});

describe('v2 tunnel entry', () => {
  it('/machines/{id}/http fast-fails 503 when no daemon is attached', async () => {
    const d = makeDaemon('mach-tun');
    await d.acquire();
    const r = await call('POST', '/joy/v2/machines/mach-tun/http', { raw: Buffer.from('sealed-junk') });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe('daemon_offline');
  });

  it('ownership is checked before the tunnel', async () => {
    const r = await call('POST', '/joy/v2/machines/mach-tun/http', { raw: Buffer.from('x'), token: 'other-token' });
    expect(r.status).toBe(403);
  });

  it('claims/tunnel long-poll returns empty on timeout under a valid lease', async () => {
    const d = makeDaemon('mach-tun2');
    await d.acquire();
    const { status, json } = await call('POST', `/joy/v2/daemon/leases/${d.leaseId}/claims/tunnel`, {
      body: { waitMs: 50 }, headers: { 'x-joy-lease-token': d.token },
    });
    expect(status).toBe(200);
    expect(json.requests ?? json.offers ?? []).toEqual([]);
  });
});

describe('v2 spawn dir-missing → client retry', () => {
  it('daemon reports dir_missing → session failed; client retry(createDir) → offer carries it → binds', async () => {
    const d = makeDaemon('mach-spawn');
    await d.acquire();
    // spawn-mode session
    const { status, json } = await call('POST', '/joy/v2/sessions', {
      body: { mode: 'spawn', daemonId: 'mach-spawn', creationIntentId: randomUUID(),
        spawnSpec: JSON.stringify({ v: 1, t: 'spawn', cwd: '/nope/missing', agent: 'claude' }) },
    });
    expect(status).toBe(200);
    const sid = json.sessionId;
    // daemon claims the spawn, reports dir_missing
    const offers = await d.claim('work');
    const spawn = offers.find(o => o.kind === 'spawn_session' && o.sessionId === sid);
    expect(spawn).toBeTruthy();
    expect(spawn.createDir).toBe(false);
    const failed = await call('POST', `/joy/v2/daemon/sessions/${sid}/spawn-failed`, { body: { reason: 'dir_missing:/nope/missing' }, headers: d.headers() });
    expect(failed.status).toBe(200);
    // session now failed with the reason; NOT offered again
    const st = await call('GET', `/joy/v2/sessions/${sid}`);
    expect(st.json.sessionState).toBe('failed');
    expect(st.json.spawnFailure).toBe('dir_missing:/nope/missing');
    expect((await d.claim('work')).some(o => o.sessionId === sid)).toBe(false);
    // client retries opting into createDir
    const retry = await call('POST', `/joy/v2/sessions/${sid}/spawn/retry`, { body: { createDir: true } });
    expect(retry.status).toBe(200);
    const st2 = await call('GET', `/joy/v2/sessions/${sid}`);
    expect(st2.json.sessionState).toBe('provisioning');
    expect(st2.json.spawnFailure).toBeNull();
    // the re-offered spawn now carries createDir; daemon binds
    const offers2 = await d.claim('work');
    const spawn2 = offers2.find(o => o.kind === 'spawn_session' && o.sessionId === sid);
    expect(spawn2).toBeTruthy();
    expect(spawn2.createDir).toBe(true);
    const bound = await d.bind(sid, { spawnCommandId: spawn2.commandId, localSessionId: 'w1', sessionKeyEnvelope: 'k' });
    expect(bound.status).toBe(200);
  });

  it('retry is refused once the session is bound', async () => {
    const d = makeDaemon('mach-spawn2');
    await d.acquire();
    const sid = await makeSession(d); // announce_existing → already bound (local_session_id set)
    const r = await call('POST', `/joy/v2/sessions/${sid}/spawn/retry`, { body: { createDir: true } });
    expect(r.status).toBe(409);
  });
});


describe('review fixes: regression coverage', () => {
  it('retry refuses an orphan with a pending cancellation', async () => {
    const d = makeDaemon('mach-rx-cxl');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'x' } })).json;
    await deliverHead(d, sessionId);
    // Cancellation lands while running, then the daemon dies → orphaned WITH
    // cancel_requested still set.
    const cxl = await call('POST', `/joy/v2/sessions/${sessionId}/turns/${m1.turnId}/cancellations`, { body: {} });
    expect(cxl.json.disposition).toBe('cancellation_requested');
    await db.query(`UPDATE daemon_leases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [d.leaseId]);
    await core.sweepExpiredLeases();
    const r = await call('POST', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}/retry`);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('cancellation_pending');
  });

  it('cancellation precondition catches a DISPATCHING turn (active_turn_id still null)', async () => {
    const d = makeDaemon('mach-disp');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'x' } })).json;
    const offers = await d.claim('work');
    const offer = offers.find((o) => o.sessionId === sessionId);
    await d.received(offer.deliveryId);
    await d.submitted(m1.turnId); // dispatching — /start never happened
    const wrong = await call('POST', `/joy/v2/sessions/${sessionId}/turns/${randomUUID()}/cancellations`, { body: {} });
    expect(wrong.status).toBe(409);
    expect(wrong.json.activeTurnId).toBe(m1.turnId);
  });

  it('ephemeral fence: foreign daemon lease is refused; inactive turn is refused', async () => {
    const dA = makeDaemon('mach-eph-a');
    await dA.acquire();
    const sessionId = await makeSession(dA);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'x' } })).json;

    // Another machine's perfectly valid lease must NOT be able to emit into
    // this session's stream by guessing the turn id.
    const dB = makeDaemon('mach-eph-b');
    await dB.acquire();
    const foreign = await call('POST', `/joy/v2/daemon/turns/${m1.turnId}/facts`, {
      body: { type: 'output', ephemeral: true, ciphertext: 'injected' }, headers: dB.headers(),
    });
    expect(foreign.status).toBe(403);

    // The owner daemon on a turn that is not executing yet: refused too.
    const early = await call('POST', `/joy/v2/daemon/turns/${m1.turnId}/facts`, {
      body: { type: 'output', ephemeral: true, ciphertext: 'too-soon' }, headers: dA.headers(),
    });
    expect(early.status).toBe(409);

    // Expired (but unreleased) lease: refused even with the right epoch.
    await deliverHead(dA, sessionId);
    await db.query(`UPDATE daemon_leases SET expires_at = now() - interval '1 minute' WHERE id = $1`, [dA.leaseId]);
    const expired = await call('POST', `/joy/v2/daemon/turns/${m1.turnId}/facts`, {
      body: { type: 'output', ephemeral: true, ciphertext: 'zombie' }, headers: dA.headers(),
    });
    expect(expired.status).toBe(412);
  });

  it('status filter applies before the page limit', async () => {
    const d = makeDaemon('mach-filter');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'a' } })).json;
    await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'b' } });
    await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'c' } });
    // Complete the first message so the seq-ordered prefix is non-queued.
    await deliverHead(d, sessionId);
    await d.fact(m1.turnId, { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() });
    const r = await call('GET', `/joy/v2/sessions/${sessionId}/messages?status=queued&limit=2`);
    // Old behavior: LIMIT 2 fetched [delivered, queued] then filtered → 1.
    expect(r.json.messages.length).toBe(2);
    expect(r.json.messages.every((x) => x.status === 'queued')).toBe(true);
  });

  it('attachment sweep spares intent-marked rows and eats aged orphans', async () => {
    const d = makeDaemon('mach-sweep');
    await d.acquire();
    const sessionId = await makeSession(d);
    const { createAttachments } = await import('../src/attachments.mjs');
    const att = createAttachments(db);
    const up = async (s) => (await call('POST', '/joy/v2/attachments', {
      raw: Buffer.from(s), headers: { 'x-session': sessionId },
    })).json.attachmentId;
    const orphan = await up('never-referenced');
    const cited = await up('cited-in-a-message');
    const ok = await call('POST', `/joy/v2/sessions/${sessionId}/messages`, {
      body: { ciphertext: 'msg', attachments: [cited] },
    });
    expect(ok.status).toBe(202);
    // Age everything past the TTL; the referenced row must survive the sweep.
    await db.query(`UPDATE attachments SET created_at = now() - interval '2 days' WHERE session_id = $1`, [sessionId]);
    const swept = await att.sweepOrphans();
    expect(swept).toBe(1);
    expect((await call('GET', `/joy/v2/attachments/${orphan}`)).status).toBe(404);
    expect((await call('GET', `/joy/v2/attachments/${cited}`)).status).toBe(200);
  });
});

describe('wave 1: durability contract (#57, #74, #116)', () => {
  it('editing a queued message after the daemon fetched it supersedes the delivery; the next claim carries the edit (#57)', async () => {
    const d = makeDaemon('mach-edit');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'A' } })).json;
    const offers = await d.claim('work');
    const offer = offers.find((o) => o.sessionId === sessionId && o.kind === 'prompt');
    expect(offer.ciphertext).toBe('A');
    // The app edits while the daemon still holds the offer (no /received yet).
    const edit = await call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`, { body: { ciphertext: 'B' } });
    expect(edit.status).toBe(200);
    // The daemon's cached delivery is refused …
    const rcv = await d.received(offer.deliveryId);
    expect(rcv.status).toBe(409);
    expect(rcv.json.error).toBe('delivery_superseded');
    // … and the next claim offers the edited payload on a fresh delivery.
    const again = (await d.claim('work')).find((o) => o.sessionId === sessionId && o.kind === 'prompt');
    expect(again.ciphertext).toBe('B');
    expect(again.deliveryId).not.toBe(offer.deliveryId);
    expect((await d.received(again.deliveryId)).status).toBe(200);
    // Once received, the message is no longer editable.
    const late = await call('PATCH', `/joy/v2/sessions/${sessionId}/messages/${m1.messageId}`, { body: { ciphertext: 'C' } });
    expect(late.status).toBe(409);
  });

  it('the owner daemon can release a running turn it has no worker for; a foreign daemon cannot (#74)', async () => {
    const d = makeDaemon('mach-release');
    await d.acquire();
    const sessionId = await makeSession(d);
    const m1 = (await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'x' } })).json;
    await deliverHead(d, sessionId); // running under d's epoch
    // Another daemon (a different epoch) may not touch it.
    const other = makeDaemon('mach-release-other');
    await other.acquire();
    const foreign = await other.reconcile(m1.turnId, { resolution: 'terminal', terminalState: 'interrupted' });
    expect([403, 409]).toContain(foreign.status);
    // The owner, same epoch, declares it has no worker: the slot is released.
    const own = await d.reconcile(m1.turnId, { resolution: 'terminal', terminalState: 'interrupted', meta: { reason: 'no_local_worker' } });
    expect(own.status).toBe(200);
    expect(own.json.terminalState).toBe('interrupted');
    // The queue moves again: a second message is offered.
    await call('POST', `/joy/v2/sessions/${sessionId}/messages`, { body: { ciphertext: 'y' } });
    const next = (await d.claim('work')).find((o) => o.sessionId === sessionId && o.kind === 'prompt');
    expect(next).toBeTruthy();
    expect(next.ciphertext).toBe('y');
  });

  it('an idempotent re-bind takes the envelope the daemon is sealing under now (#116)', async () => {
    const d = makeDaemon('mach-rebind');
    await d.acquire();
    const localSessionId = randomUUID().slice(0, 8);
    const created = await call('POST', '/joy/v2/sessions', {
      body: { mode: 'announce_existing', creationIntentId: randomUUID(), daemonId: d.daemonId, localSessionId, sessionKeyEnvelope: 'env-A' },
    });
    const sessionId = created.json.sessionId;
    const rebind = await d.bind(sessionId, { localSessionId, sessionKeyEnvelope: 'env-B' });
    expect(rebind.status).toBe(200);
    const { rows: [row] } = await db.query(`SELECT session_key_envelope FROM native_sessions WHERE id = $1`, [sessionId]);
    expect(row.session_key_envelope).toBe('env-B');
    // A different local id is still refused.
    const clash = await d.bind(sessionId, { localSessionId: 'zzzzzzzz', sessionKeyEnvelope: 'env-C' });
    expect(clash.status).toBe(409);
  });
});

