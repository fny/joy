// Integration tests for the native nucleus: a real HTTP server over an
// in-memory PGlite store, driven by a fake app and a fake daemon exercising
// the full contract — acceptance, delivery, facts, cancellation (all three
// dispositions + barrier), idempotency, fencing, orphaning, reads.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDb } from '../src/db.mjs';
import { createCore } from '../src/core.mjs';
import { createNotify } from '../src/notify.mjs';
import { createRouter } from '../src/routes.mjs';

const TOKENS = new Map([['app-token', 'account-1'], ['other-token', 'account-2']]);

let server, base, db, core, notify;

beforeAll(async () => {
  db = await openDb(':memory:');
  notify = createNotify();
  core = createCore(db, notify);
  const auth = { verifyToken: async (t) => TOKENS.get(t) ?? null };
  const router = createRouter({ core, auth, notify, db });
  server = http.createServer(async (req, res) => {
    if (await router.handle(req, res)) return;
    res.writeHead(599); res.end('would-passthrough');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.close();
  await db.close();
});

async function call(method, path, { body, token = 'app-token', headers = {} } = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* SSE / non-json */ }
  return { status: r.status, json, text };
}

/** Fake daemon: lease + claim + fact helpers. */
function makeDaemon(daemonId) {
  const d = { daemonId, leaseId: null, token: null, epoch: null };
  d.headers = () => ({
    'x-joy-lease-id': d.leaseId, 'x-joy-lease-token': d.token, 'x-joy-lease-epoch': d.epoch,
  });
  d.acquire = async () => {
    const { status, json } = await call('POST', `/joy/v1/daemons/${daemonId}/leases`, { body: {} });
    expect(status).toBe(200);
    d.leaseId = json.leaseId; d.token = json.leaseToken; d.epoch = json.epoch;
    return json;
  };
  d.claim = async (lane) => {
    const { status, json } = await call('POST', `/joy/v1/daemon-leases/${d.leaseId}/claims/${lane}`, {
      body: { noWait: true },
      headers: { 'x-joy-lease-token': d.token, 'x-joy-lease-epoch': d.epoch },
    });
    expect(status).toBe(200);
    return json.offers;
  };
  d.received = (deliveryId) => call('POST', `/joy/v1/deliveries/${deliveryId}/received`, { headers: d.headers() });
  d.submitted = (turnId) => call('POST', `/joy/v1/turns/${turnId}/submitted`, { headers: d.headers() });
  d.start = (turnId, body = {}) => call('POST', `/joy/v1/turns/${turnId}/start`, { body, headers: d.headers() });
  d.fact = (turnId, body) => call('POST', `/joy/v1/turns/${turnId}/facts`, { body, headers: d.headers() });
  d.reconcile = (turnId, body) => call('POST', `/joy/v1/turns/${turnId}/reconcile`, { body, headers: d.headers() });
  d.bind = (sessionId, body) => call('POST', `/joy/v1/sessions/${sessionId}/bind`, { body, headers: d.headers() });
  return d;
}

async function makeNativeSession(daemon) {
  const creationIntentId = randomUUID();
  const { status, json } = await call('POST', '/joy/v1/session-creations', {
    body: { mode: 'announce_existing', creationIntentId, daemonId: daemon.daemonId, localSessionId: randomUUID().slice(0, 8), sessionKeyEnvelope: 'wrapped-key' },
  });
  expect(status).toBe(200);
  return json.sessionId;
}

describe('capabilities and auth', () => {
  it('capabilities is public', async () => {
    const { status, json } = await call('GET', '/joy/v1/capabilities', { token: null });
    expect(status).toBe(200);
    expect(json.protocol.major).toBe(1);
  });

  it('rejects unauthenticated session reads', async () => {
    const r = await fetch(base + '/joy/v1/sessions');
    expect(r.status).toBe(401);
  });

  it('non-native routes fall through to passthrough', async () => {
    const r = await fetch(base + '/v1/account/profile');
    expect(r.status).toBe(599);
  });
});

describe('session creation', () => {
  it('announce_existing creates a starting session, idempotently', async () => {
    const daemon = makeDaemon('daemon-a');
    await daemon.acquire();
    const creationIntentId = randomUUID();
    const body = { mode: 'announce_existing', creationIntentId, daemonId: 'daemon-a', localSessionId: 'abc12345', sessionKeyEnvelope: 'k' };
    const first = await call('POST', '/joy/v1/session-creations', { body });
    const second = await call('POST', '/joy/v1/session-creations', { body });
    expect(first.json.sessionId).toBe(second.json.sessionId);
    expect(second.json.replay).toBe(true);
  });

  it('spawn mode provisions and delivers a spawn command the daemon binds', async () => {
    const daemon = makeDaemon('daemon-spawn');
    await daemon.acquire();
    const { json: created } = await call('POST', '/joy/v1/session-creations', {
      body: { creationIntentId: randomUUID(), daemonId: 'daemon-spawn', spawnSpec: 'encrypted-spec' },
    });
    expect(created.state).toBe('provisioning');
    const offers = await daemon.claim('work');
    const spawn = offers.find((o) => o.kind === 'spawn_session' && o.sessionId === created.sessionId);
    expect(spawn).toBeTruthy();
    await daemon.received(spawn.deliveryId);
    const bind = await daemon.bind(created.sessionId, {
      spawnCommandId: spawn.commandId, localSessionId: 'loc00001', sessionKeyEnvelope: 'wrapped',
    });
    expect(bind.status).toBe(200);
    const { json: state } = await call('GET', `/joy/v1/sessions/${created.sessionId}/state`);
    expect(state.sessionState).toBe('starting');
  });
});

describe('prompt lifecycle end to end', () => {
  it('accept → claim → receive → submit → start → output → terminal, with honest state throughout', async () => {
    const daemon = makeDaemon('daemon-b');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);

    const clientIntentId = randomUUID();
    const { status, json: accepted } = await call('POST', `/joy/v1/sessions/${sessionId}/turns`, {
      body: { clientIntentId, ciphertext: 'enc(hello)' },
    });
    expect(status).toBe(200);
    expect(accepted.disposition).toBe('queued');
    expect(accepted.seq).toBeTruthy();
    expect(accepted.turnId).toBeTruthy();

    // Idempotent replay returns identical acceptance
    const replay = await call('POST', `/joy/v1/sessions/${sessionId}/turns`, {
      body: { clientIntentId, ciphertext: 'enc(hello)' },
    });
    expect(replay.json.seq).toBe(accepted.seq);
    expect(replay.json.commandId).toBe(accepted.commandId);

    // Same intent id, different content → 409
    const tampered = await call('POST', `/joy/v1/sessions/${sessionId}/turns`, {
      body: { clientIntentId, ciphertext: 'enc(EVIL)' },
    });
    expect(tampered.status).toBe(409);

    let state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.queue.queuedTurns).toBe(1);
    expect(state.execution.state).toBe('idle');
    expect(state.daemon.status).toBe('online');

    const offers = await daemon.claim('work');
    const offer = offers.find((o) => o.turnId === accepted.turnId);
    expect(offer.ciphertext).toBe('enc(hello)');
    await daemon.received(offer.deliveryId);
    await daemon.submitted(offer.turnId);
    const started = await daemon.start(offer.turnId, { runtimeEventId: 'hook-1' });
    expect(started.json.state).toBe('running');

    state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.execution.state).toBe('running');
    expect(state.execution.turnId).toBe(accepted.turnId);

    // double-start replays, second prompt can't start concurrently
    expect((await daemon.start(offer.turnId)).json.replay).toBe(true);

    const out = await daemon.fact(offer.turnId, { type: 'output', kind: 'assistant', ciphertext: 'enc(answer)', runtimeEventId: 'jsonl-uuid-1' });
    expect(out.status).toBe(200);
    // duplicate runtime event collapses
    const dupe = await daemon.fact(offer.turnId, { type: 'output', kind: 'assistant', ciphertext: 'enc(answer)', runtimeEventId: 'jsonl-uuid-1' });
    expect(dupe.json.replay).toBe(true);

    const term = await daemon.fact(offer.turnId, { type: 'terminal', terminalState: 'completed' });
    expect(term.status).toBe(200);

    state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.execution.state).toBe('idle');
    expect(state.queue.queuedTurns).toBe(0);

    const events = (await call('GET', `/joy/v1/sessions/${sessionId}/events?after_seq=0`)).json;
    const kinds = events.messages.map((m) => m.kind);
    expect(kinds).toContain('turn.queued');
    expect(kinds).toContain('turn.started');
    expect(kinds).toContain('turn.terminal');
    const queuedEvt = events.messages.find((m) => m.kind === 'turn.queued');
    expect(queuedEvt.origin.clientIntentId).toBe(clientIntentId);
    expect(queuedEvt.content.ciphertext).toBe('enc(hello)');
  });

  it('second prompt is not offered while the first is executing; offered after terminal', async () => {
    const daemon = makeDaemon('daemon-c');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const a = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'A' } })).json;
    const b = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'B' } })).json;

    let offers = await daemon.claim('work');
    expect(offers.map((o) => o.turnId)).toEqual([a.turnId]);
    await daemon.received(offers[0].deliveryId);
    await daemon.submitted(a.turnId);
    await daemon.start(a.turnId);
    // nothing new while running
    expect((await daemon.claim('work')).length).toBe(0);
    await daemon.fact(a.turnId, { type: 'terminal', terminalState: 'completed' });
    offers = await daemon.claim('work');
    expect(offers.map((o) => o.turnId)).toEqual([b.turnId]);
  });
});

describe('cancellation', () => {
  it('cancel-before-start suppresses delivery and refuses a late start', async () => {
    const daemon = makeDaemon('daemon-d');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const accepted = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const cancel = (await call('POST', `/joy/v1/sessions/${sessionId}/turns/${accepted.turnId}/cancellations`, {
      body: { clientIntentId: randomUUID(), scope: 'turn' },
    })).json;
    expect(cancel.disposition).toBe('cancelled_before_start');
    // no delivery offered
    expect((await daemon.claim('work')).length).toBe(0);
    // a late start (e.g. daemon raced the claim earlier) is refused
    const late = await daemon.start(accepted.turnId);
    expect(late.status).toBe(409);
  });

  it('cancelling a running turn delivers on the control lane and resolves on terminal evidence', async () => {
    const daemon = makeDaemon('daemon-e');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const accepted = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const [offer] = await daemon.claim('work');
    await daemon.received(offer.deliveryId);
    await daemon.submitted(accepted.turnId);
    await daemon.start(accepted.turnId);

    const cancel = (await call('POST', `/joy/v1/sessions/${sessionId}/turns/${accepted.turnId}/cancellations`, {
      body: { clientIntentId: randomUUID() },
    })).json;
    expect(cancel.disposition).toBe('cancellation_requested');

    const state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.execution.state).toBe('cancelling');
    expect(state.execution.cancelRequested).toBe(true);

    const control = await daemon.claim('control');
    expect(control[0].kind).toBe('cancel');
    expect(control[0].targetTurnId).toBe(accepted.turnId);
    await daemon.received(control[0].deliveryId);

    // daemon confirms with evidence (Escape observed in JSONL)
    await daemon.fact(accepted.turnId, { type: 'terminal', terminalState: 'cancelled', meta: { mode: 'graceful' } });
    const after = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(after.execution.state).toBe('idle');
  });

  it('barrier scope drains queued turns; work accepted after the cancel survives', async () => {
    const daemon = makeDaemon('daemon-f');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t1 = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: '1' } })).json;
    const t2 = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: '2' } })).json;
    const t3 = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: '3' } })).json;
    const [offer] = await daemon.claim('work');
    await daemon.received(offer.deliveryId);
    await daemon.submitted(t1.turnId);
    await daemon.start(t1.turnId);

    await call('POST', `/joy/v1/sessions/${sessionId}/turns/${t1.turnId}/cancellations`, {
      body: { clientIntentId: randomUUID(), scope: 'turn_and_pending_before_barrier' },
    });
    // accepted AFTER the barrier → survives
    const t4 = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: '4' } })).json;

    await daemon.fact(t1.turnId, { type: 'terminal', terminalState: 'cancelled' });
    const offers = await daemon.claim('work');
    expect(offers.map((o) => o.turnId)).toEqual([t4.turnId]);

    const state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.queue.queuedTurns).toBe(1); // only t4 (t2, t3 drained)
    void t2; void t3;
  });

  it('cancelling a terminal turn reports already_terminal', async () => {
    const daemon = makeDaemon('daemon-g');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const [offer] = await daemon.claim('work');
    await daemon.received(offer.deliveryId);
    await daemon.start(t.turnId);
    await daemon.fact(t.turnId, { type: 'terminal', terminalState: 'completed' });
    const cancel = (await call('POST', `/joy/v1/sessions/${sessionId}/turns/${t.turnId}/cancellations`, {
      body: { clientIntentId: randomUUID() },
    })).json;
    expect(cancel.disposition).toBe('already_terminal');
  });
});

describe('fencing and recovery', () => {
  it('a new lease fences out the old epoch; reconcile-running resumes the orphan', async () => {
    const daemon = makeDaemon('daemon-h');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const [offer] = await daemon.claim('work');
    await daemon.received(offer.deliveryId);
    await daemon.submitted(t.turnId);
    await daemon.start(t.turnId);

    const oldHeaders = daemon.headers();
    await daemon.acquire(); // restart → new epoch

    // old-process write is fenced
    const stale = await call('POST', `/joy/v1/turns/${t.turnId}/facts`, {
      body: { type: 'output', ciphertext: 'zombie', runtimeEventId: 'z1' },
      headers: oldHeaders,
    });
    expect([401, 412]).toContain(stale.status);

    // reconcile is refused until the sweep declares the turn orphaned
    const early = await daemon.reconcile(t.turnId, { resolution: 'running' });
    expect(early.status).toBe(409);

    await core.sweepExpiredLeases();
    const state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.recoveryRequired).toBe(true);
    expect(state.execution.state).toBe('orphaned');

    // daemon found JSONL evidence → resumes ownership under the new epoch
    const rec = await daemon.reconcile(t.turnId, { resolution: 'running' });
    expect(rec.json.state).toBe('running');
    const after = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(after.recoveryRequired).toBe(false);
    expect(after.execution.state).toBe('running');
  });

  it('reconcile-terminal on an orphan goes through shared terminalization and resolves pending cancels', async () => {
    const daemon = makeDaemon('daemon-h2');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const [offer] = await daemon.claim('work');
    await daemon.received(offer.deliveryId);
    await daemon.submitted(t.turnId);
    await daemon.start(t.turnId);
    // user mashes Stop while the daemon is dying
    await call('POST', `/joy/v1/sessions/${sessionId}/turns/${t.turnId}/cancellations`, { body: { clientIntentId: randomUUID() } });
    await daemon.acquire(); // restart
    await core.sweepExpiredLeases();

    const rec = await daemon.reconcile(t.turnId, { resolution: 'terminal', terminalState: 'interrupted' });
    expect(rec.json.terminalState).toBe('interrupted');
    // the pending cancel command was resolved by terminalization — control lane is empty
    expect((await daemon.claim('control')).length).toBe(0);
    const state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.execution.state).toBe('idle');
    expect(state.recoveryRequired).toBe(false);
  });

  it('crash AFTER submit (dispatching, never started) is swept to orphaned', async () => {
    const daemon = makeDaemon('daemon-h3');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const [offer] = await daemon.claim('work');
    await daemon.received(offer.deliveryId);
    await daemon.submitted(t.turnId);
    await daemon.acquire(); // crash + restart before start
    const swept = await core.sweepExpiredLeases();
    expect(swept).toBeGreaterThan(0);
    const state = (await call('GET', `/joy/v1/sessions/${sessionId}/state`)).json;
    expect(state.recoveryRequired).toBe(true);
    expect(state.execution.state).toBe('orphaned');
    // ambiguous Enter-sent window with no evidence → daemon terminalizes as indeterminate-interrupted
    const rec = await daemon.reconcile(t.turnId, { resolution: 'terminal', terminalState: 'interrupted' });
    expect(rec.status).toBe(200);
  });

  it('daemon restart before submit re-offers the undelivered prompt under the new epoch', async () => {
    const daemon = makeDaemon('daemon-i');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const [first] = await daemon.claim('work');
    expect(first.turnId).toBe(t.turnId);
    // crash before received/submitted; new lease
    await daemon.acquire();
    const offers = await daemon.claim('work');
    expect(offers.map((o) => o.turnId)).toEqual([t.turnId]);
  });
});

describe('review regressions', () => {
  it('repeated claims re-offer the SAME head delivery — never skip to the next prompt', async () => {
    const daemon = makeDaemon('daemon-r1');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t1 = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: '1' } })).json;
    await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: '2' } });
    const a = await daemon.claim('work');
    const b = await daemon.claim('work'); // claim response "lost", daemon retries
    expect(a.length).toBe(1);
    expect(b.length).toBe(1);
    expect(a[0].turnId).toBe(t1.turnId);
    expect(b[0].turnId).toBe(t1.turnId);
    expect(b[0].deliveryId).toBe(a[0].deliveryId);
  });

  it('start without a current-epoch delivery is refused', async () => {
    const daemon = makeDaemon('daemon-r2');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const early = await daemon.start(t.turnId);
    expect(early.status).toBe(409);
    expect(early.json.error).toBe('no_current_delivery');
  });

  it('an expired lease cannot bind or write, even with valid credentials', async () => {
    const daemon = makeDaemon('daemon-r3');
    await daemon.acquire();
    const { json: created } = await call('POST', '/joy/v1/session-creations', {
      body: { creationIntentId: randomUUID(), daemonId: 'daemon-r3', spawnSpec: 'spec' },
    });
    const offers = await daemon.claim('work');
    const spawn = offers.find((o) => o.kind === 'spawn_session');
    await db.query(`UPDATE daemon_leases SET expires_at = now() - interval '1 second' WHERE id = $1`, [daemon.leaseId]);
    const bind = await daemon.bind(created.sessionId, {
      spawnCommandId: spawn.commandId, localSessionId: 'exp00001', sessionKeyEnvelope: 'w',
    });
    expect(bind.status).toBe(412);
  });

  it('cross-account daemon targeting is rejected; unknown daemons cannot be targeted', async () => {
    const daemon = makeDaemon('daemon-r4');
    await daemon.acquire(); // owned by account-1
    const cross = await call('POST', '/joy/v1/session-creations', {
      token: 'other-token',
      body: { creationIntentId: randomUUID(), daemonId: 'daemon-r4', spawnSpec: 's' },
    });
    expect(cross.status).toBe(403);
    const unknown = await call('POST', '/joy/v1/session-creations', {
      body: { creationIntentId: randomUUID(), daemonId: 'never-leased', spawnSpec: 's' },
    });
    expect(unknown.status).toBe(409);
  });

  it('creation-intent reuse with different content is a 409, not a silent replay', async () => {
    const daemon = makeDaemon('daemon-r5');
    await daemon.acquire();
    const creationIntentId = randomUUID();
    const first = await call('POST', '/joy/v1/session-creations', {
      body: { mode: 'announce_existing', creationIntentId, daemonId: 'daemon-r5', localSessionId: 'aaa11111', sessionKeyEnvelope: 'k1' },
    });
    expect(first.status).toBe(200);
    const changed = await call('POST', '/joy/v1/session-creations', {
      body: { mode: 'announce_existing', creationIntentId, daemonId: 'daemon-r5', localSessionId: 'bbb22222', sessionKeyEnvelope: 'k2' },
    });
    expect(changed.status).toBe(409);
  });

  it('prompts are rejected while a spawned session is still provisioning', async () => {
    const daemon = makeDaemon('daemon-r6');
    await daemon.acquire();
    const { json: created } = await call('POST', '/joy/v1/session-creations', {
      body: { creationIntentId: randomUUID(), daemonId: 'daemon-r6', spawnSpec: 'spec' },
    });
    const r = await call('POST', `/joy/v1/sessions/${created.sessionId}/turns`, {
      body: { clientIntentId: randomUUID(), ciphertext: 'early' },
    });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('session_not_ready');
  });

  it('retrying a receipt fact with the same runtimeEventId replays instead of 500ing', async () => {
    const daemon = makeDaemon('daemon-r7');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const t = (await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'X' } })).json;
    const [offer] = await daemon.claim('work');
    await daemon.received(offer.deliveryId);
    await daemon.submitted(t.turnId);
    await daemon.start(t.turnId);
    const r1 = await daemon.fact(t.turnId, { type: 'receipt', transcriptUuid: 'tu-1', runtimeEventId: 'receipt-evt-1' });
    expect(r1.status).toBe(200);
    const r2 = await daemon.fact(t.turnId, { type: 'receipt', transcriptUuid: 'tu-1', runtimeEventId: 'receipt-evt-1' });
    expect(r2.status).toBe(200);
    expect(r2.json.replay).toBe(true);
  });

  it('bind requires the exact spawn command', async () => {
    const daemon = makeDaemon('daemon-r8');
    await daemon.acquire();
    const { json: created } = await call('POST', '/joy/v1/session-creations', {
      body: { creationIntentId: randomUUID(), daemonId: 'daemon-r8', spawnSpec: 'spec' },
    });
    const noCmd = await daemon.bind(created.sessionId, { localSessionId: 'x1', sessionKeyEnvelope: 'w' });
    expect(noCmd.status).toBe(400);
    const wrongCmd = await daemon.bind(created.sessionId, {
      spawnCommandId: randomUUID(), localSessionId: 'x1', sessionKeyEnvelope: 'w',
    });
    expect(wrongCmd.status).toBe(404);
  });
});

describe('limits and isolation', () => {
  it('rejects oversized ciphertext', async () => {
    const daemon = makeDaemon('daemon-j');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const { status } = await call('POST', `/joy/v1/sessions/${sessionId}/turns`, {
      body: { clientIntentId: randomUUID(), ciphertext: 'x'.repeat(300 * 1024) },
    });
    expect(status).toBe(413);
  });

  it("another account cannot see or mutate the session", async () => {
    const daemon = makeDaemon('daemon-k');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const read = await call('GET', `/joy/v1/sessions/${sessionId}/state`, { token: 'other-token' });
    expect(read.status).toBe(404);
    const write = await call('POST', `/joy/v1/sessions/${sessionId}/turns`, {
      token: 'other-token', body: { clientIntentId: randomUUID(), ciphertext: 'X' },
    });
    expect(write.status).toBe(404);
  });

  it('events paginate with hasMore', async () => {
    const daemon = makeDaemon('daemon-l');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    for (let i = 0; i < 5; i++) {
      await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: `m${i}` } });
    }
    const page1 = (await call('GET', `/joy/v1/sessions/${sessionId}/events?after_seq=0&limit=3`)).json;
    expect(page1.messages.length).toBe(3);
    expect(page1.hasMore).toBe(true);
    const page2 = (await call('GET', `/joy/v1/sessions/${sessionId}/events?after_seq=${page1.messages.at(-1).seq}&limit=50`)).json;
    expect(page2.hasMore).toBe(false);
    const seqs = [...page1.messages, ...page2.messages].map((m) => Number(m.seq));
    expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
  });
});

describe('long-poll claims', () => {
  it('a parked work claim wakes when a prompt is accepted', async () => {
    const daemon = makeDaemon('daemon-m');
    await daemon.acquire();
    const sessionId = await makeNativeSession(daemon);
    const parked = call('POST', `/joy/v1/daemon-leases/${daemon.leaseId}/claims/work`, {
      body: { waitMs: 5000 },
      headers: { 'x-joy-lease-token': daemon.token, 'x-joy-lease-epoch': daemon.epoch },
    });
    await new Promise((r) => setTimeout(r, 150));
    const t0 = Date.now();
    await call('POST', `/joy/v1/sessions/${sessionId}/turns`, { body: { clientIntentId: randomUUID(), ciphertext: 'wake' } });
    const { json } = await parked;
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(json.offers.length).toBe(1);
  });
});
