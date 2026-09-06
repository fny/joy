// Wave D (review campaign 2026-09) — session-plane durability fixes, each
// reproduced end to end against an in-process relay: real HTTP, real PGlite,
// a fake app and a fake daemon speaking only /joy/v2.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ApiError, MAX_EVENTS_PER_SESSION } from '../src/core.mjs';
import { startRelay, sleep } from './harness.mjs';

let relay, base, db, core, attachments, call, makeDaemon, makeSession, post, getMsg, offerFor;

beforeAll(async () => {
  relay = await startRelay();
  ({ base, db, core, attachments, call, makeDaemon, makeSession, post, getMsg, offerFor } = relay);
});
afterAll(() => relay.close());

describe('#612 a delayed spawn-failed report cannot undo a bound retry', () => {
  async function spawnSession(d) {
    const { status, json } = await call('POST', '/joy/v2/sessions', {
      body: { mode: 'spawn', daemonId: d.daemonId, creationIntentId: randomUUID(), spawnSpec: '{"cwd":"/nope"}' },
    });
    expect(status).toBe(200);
    return json.sessionId;
  }

  it('a report for the superseded attempt is acknowledged but not applied once the retry has bound', async () => {
    const d = makeDaemon('mach-612a'); await d.acquire();
    const sid = await spawnSession(d);
    const first = offerFor(await d.claim('work'), sid, 'spawn_session');
    await d.received(first.deliveryId);
    // Attempt 1 fails; the client retries; attempt 2 binds.
    expect((await d.spawnFailed(sid, { reason: 'dir_missing:/nope', deliveryId: first.deliveryId })).json).toMatchObject({ ok: true, applied: true });
    expect((await call('POST', `/joy/v2/sessions/${sid}/spawn/retry`, { body: { createDir: true } })).status).toBe(200);
    const second = offerFor(await d.claim('work'), sid, 'spawn_session');
    expect(second.deliveryId).not.toBe(first.deliveryId);
    await d.received(second.deliveryId);
    expect((await d.bind(sid, { spawnCommandId: second.commandId, localSessionId: 'w612', sessionKeyEnvelope: 'k' })).status).toBe(200);

    // The delayed retry of attempt 1's failure report arrives now — with its
    // delivery id, and (an older daemon) without one. Neither may apply.
    const stale = await d.spawnFailed(sid, { reason: 'dir_missing:/nope', deliveryId: first.deliveryId });
    expect(stale.status).toBe(200);
    expect(stale.json).toMatchObject({ ok: true, applied: false });
    const bare = await d.spawnFailed(sid, { reason: 'dir_missing:/nope' });
    expect(bare.json).toMatchObject({ ok: true, applied: false, reason: 'already_bound' });

    const st = (await call('GET', `/joy/v2/sessions/${sid}`)).json;
    expect(st.sessionState).toBe('starting');
    expect(st.spawnFailure).toBeNull();
    // The bound session still takes prompts and still offers work.
    expect((await post(sid, { ciphertext: 'hello' })).status).toBe(202);
    expect(offerFor(await d.claim('work'), sid)).toBeTruthy();
  });

  it('while the retry is still in flight, only a report naming the live attempt applies', async () => {
    const d = makeDaemon('mach-612b'); await d.acquire();
    const sid = await spawnSession(d);
    const first = offerFor(await d.claim('work'), sid, 'spawn_session');
    await d.received(first.deliveryId);
    await d.spawnFailed(sid, { reason: 'dir_missing:/nope', deliveryId: first.deliveryId });
    await call('POST', `/joy/v2/sessions/${sid}/spawn/retry`, { body: { createDir: true } });
    const second = offerFor(await d.claim('work'), sid, 'spawn_session');
    // Attempt 1's report, delayed: the delivery it names was superseded by the retry.
    expect((await d.spawnFailed(sid, { reason: 'late', deliveryId: first.deliveryId })).json).toMatchObject({ applied: false, reason: 'stale_attempt' });
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).json.sessionState).toBe('provisioning');
    // Attempt 2's own report applies.
    expect((await d.spawnFailed(sid, { reason: 'clone_failed', deliveryId: second.deliveryId })).json).toMatchObject({ applied: true });
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).json).toMatchObject({ sessionState: 'failed', spawnFailure: 'clone_failed' });
  });

  it('a report WITHOUT deliveryId (older daemon) is ambiguous once a retry exists, and cannot fail the retry', async () => {
    const d = makeDaemon('mach-612c'); await d.acquire();
    const sid = await spawnSession(d);
    const first = offerFor(await d.claim('work'), sid, 'spawn_session');
    await d.received(first.deliveryId);
    expect((await d.spawnFailed(sid, { reason: 'dir_missing:/nope' })).json).toMatchObject({ applied: true });
    expect((await call('POST', `/joy/v2/sessions/${sid}/spawn/retry`, { body: { createDir: true } })).status).toBe(200);
    // Retry accepted, attempt 2 not yet claimed: the only delivery is superseded → ambiguous.
    expect((await d.spawnFailed(sid, { reason: 'dir_missing:/nope' })).json).toMatchObject({ ok: true, applied: false, reason: 'ambiguous_attempt' });
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).json.sessionState).toBe('provisioning');
    // Attempt 2 in flight: attempt 1's late bare report must not fail it.
    const second = offerFor(await d.claim('work'), sid, 'spawn_session');
    expect(second).toBeTruthy();
    await d.received(second.deliveryId);
    const late = await d.spawnFailed(sid, { reason: 'dir_missing:/nope' });
    expect(late.status).toBe(200);
    expect(late.json).toMatchObject({ ok: true, applied: false, reason: 'ambiguous_attempt' });
    const st = (await call('GET', `/joy/v2/sessions/${sid}`)).json;
    expect(st.sessionState).toBe('provisioning');
    expect(st.spawnFailure).toBeNull();
    // Attempt 2 still binds, and the bound session works.
    expect((await d.bind(sid, { spawnCommandId: second.commandId, localSessionId: 'w612c', sessionKeyEnvelope: 'k' })).status).toBe(200);
    expect((await post(sid, { ciphertext: 'hello' })).status).toBe(202);
    expect(offerFor(await d.claim('work'), sid)).toBeTruthy();
  });

  it('a single-attempt legacy report (no retry ever) still applies', async () => {
    const d = makeDaemon('mach-612d'); await d.acquire();
    const sid = await spawnSession(d);
    const first = offerFor(await d.claim('work'), sid, 'spawn_session');
    await d.received(first.deliveryId);
    expect((await d.spawnFailed(sid, { reason: 'dir_missing:/nope' })).json).toMatchObject({ ok: true, applied: true });
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).json).toMatchObject({ sessionState: 'failed', spawnFailure: 'dir_missing:/nope' });
    expect(offerFor(await d.claim('work'), sid, 'spawn_session')).toBeUndefined();
  });
});

describe('#613 the event budget is enforced at claim and at start, not only at admission', () => {
  // Fill the log to an absolute TOTAL (the session already holds its
  // creation events), with seqs far above the live counter.
  const fill = async (sid, total) => {
    const { rows: [{ n }] } = await db.query(`SELECT count(*)::int AS n FROM session_events WHERE session_id = $1`, [sid]);
    await db.query(
      `INSERT INTO session_events (session_id, seq, event_id, kind)
       SELECT $1, 1000000 + g, 'e' || g, 'output' FROM generate_series(1, $2) AS g`, [sid, total - n]);
  };
  const turnRow = (turnId) => db.query(`SELECT * FROM turns WHERE id = $1`, [turnId]).then((r) => r.rows[0]);

  it('a turn admitted under the cap is failed (not offered) once the earlier turn consumed the budget', async () => {
    const d = makeDaemon('mach-613c'); await d.acquire();
    const sid = await makeSession(d);
    await fill(sid, MAX_EVENTS_PER_SESSION - 8);
    // Both admitted under the cap: A needs 3, B needs 3 more of the 8 left.
    const a = (await post(sid, { ciphertext: 'A' })).json;
    const b = (await post(sid, { ciphertext: 'B' })).json;
    expect(a.turnId && b.turnId).toBeTruthy();
    // A session under the cap offers normally: A is offered and runs.
    const offer = offerFor(await d.claim('work'), sid);
    expect(offer.turnId).toBe(a.turnId);
    await d.received(offer.deliveryId);
    await d.submitted(a.turnId);
    expect((await d.start(a.turnId, { runtimeEventId: randomUUID() })).status).toBe(200);
    // A's real output facts fill the log until the relay refuses the next one.
    let stored = 0;
    for (let i = 0; i < 20; i++) {
      const r = await d.fact(a.turnId, { type: 'output', ciphertext: 'o' + i, runtimeEventId: randomUUID() });
      if (r.status === 429) { expect(r.json.error).toBe('session_event_budget_exhausted'); break; }
      expect(r.status).toBe(200); stored++;
    }
    expect(stored).toBeGreaterThan(0);
    expect((await d.fact(a.turnId, { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() })).status).toBe(200);
    // B is head now. Nothing of its output could be stored: not offered, failed definitively.
    expect(offerFor(await d.claim('work'), sid)).toBeUndefined();
    const turn = (await call('GET', `/joy/v2/sessions/${sid}/turns/${b.turnId}`)).json;
    expect(turn).toMatchObject({ state: 'terminal', terminalState: 'failed' });
    expect((await turnRow(b.turnId)).terminal_meta).toEqual({ reason: 'session_event_budget_exhausted' });
    const msg = (await getMsg(sid, b.messageId)).json;
    expect(msg.status).toBe('failed');
    expect(msg.failure.retryable).toBe(false);
    // Stable: a second claim finds nothing left to fail or offer.
    expect(offerFor(await d.claim('work'), sid)).toBeUndefined();
  }, 30_000);

  it('a turn whose budget vanished between claim and start is failed at start; the daemon gets a 409 and its delivery is superseded', async () => {
    const d = makeDaemon('mach-613d'); await d.acquire();
    const sid = await makeSession(d);
    await fill(sid, MAX_EVENTS_PER_SESSION - 8);
    const b = (await post(sid, { ciphertext: 'B' })).json;
    const offer = offerFor(await d.claim('work'), sid);
    expect(offer.turnId).toBe(b.turnId);
    await d.received(offer.deliveryId);
    await d.submitted(b.turnId);
    // Out-of-turn output (a prompt typed at the terminal) eats the reserve.
    for (let i = 0; i < 20; i++) {
      const r = await call('POST', `/joy/v2/daemon/sessions/${sid}/facts`,
        { body: { type: 'output', ciphertext: 't' + i, runtimeEventId: randomUUID() }, headers: d.headers() });
      if (r.status === 429) break;
      expect(r.status).toBe(200);
    }
    const start = await d.start(b.turnId, { runtimeEventId: randomUUID() });
    expect(start.status).toBe(409);
    expect(start.json.error).toBe('session_event_budget_exhausted');
    // Committed despite the 409: the turn is failed, the message reads failed, the delivery is dead.
    expect(await turnRow(b.turnId)).toMatchObject({ state: 'terminal', terminal_state: 'failed', terminal_meta: { reason: 'session_event_budget_exhausted' } });
    expect((await getMsg(sid, b.messageId)).json.status).toBe('failed');
    expect((await d.received(offer.deliveryId)).status).toBe(409);
    expect(offerFor(await d.claim('work'), sid)).toBeUndefined();
    // The daemon's cancel-class follow-up to a refused start replays; the failed terminal stands.
    expect((await d.fact(b.turnId, { type: 'terminal', terminalState: 'cancelled', runtimeEventId: randomUUID() })).json).toMatchObject({ ok: true, replay: true });
    expect((await turnRow(b.turnId)).terminal_state).toBe('failed');
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).json.sessionState).not.toBe('failed'); // the SESSION is not failed, only the turn
  }, 30_000);
});

describe('#613 an exhausted session refuses new prompts at admission', () => {
  it('POST /messages answers 429 session_event_budget_exhausted and nothing is offered', async () => {
    const d = makeDaemon('mach-613'); await d.acquire();
    const sid = await makeSession(d);
    // Fill the session's event budget directly (seqs far above the live
    // counter so the primary key never collides with real events).
    await db.query(
      `INSERT INTO session_events (session_id, seq, event_id, kind)
       SELECT $1, 1000000 + g, 'e' || g, 'output' FROM generate_series(1, $2) AS g`, [sid, MAX_EVENTS_PER_SESSION]);
    const r = await post(sid, { ciphertext: 'one more' });
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('session_event_budget_exhausted');
    // Not accepted → not queued → not offered: the relay authorizes no work it cannot record.
    expect((await call('GET', `/joy/v2/sessions/${sid}/messages`)).json.messages).toEqual([]);
    expect(offerFor(await d.claim('work'), sid)).toBeUndefined();
  }, 30_000);

  it('admission keeps lifecycle room for turns that are already accepted', async () => {
    const d = makeDaemon('mach-613b'); await d.acquire();
    const sid = await makeSession(d);
    // Two turns' worth of headroom (3 lifecycle events each) left.
    await db.query(
      `INSERT INTO session_events (session_id, seq, event_id, kind)
       SELECT $1, 1000000 + g, 'e' || g, 'output' FROM generate_series(1, $2) AS g`, [sid, MAX_EVENTS_PER_SESSION - 7]);
    expect((await post(sid, { ciphertext: 'fits' })).status).toBe(202);
    // The second would need room for itself AND the open one: refused.
    const r = await post(sid, { ciphertext: 'does not fit' });
    expect(r.status).toBe(429);
    expect(r.json.error).toBe('session_event_budget_exhausted');
  }, 30_000);
});

describe('#614 archiving is final: a late submit/start cannot reopen the session', () => {
  it('a start that was in flight when the daemon archived is refused and the session stays archived', async () => {
    const d = makeDaemon('mach-614a'); await d.acquire();
    const sid = await makeSession(d);
    const { turnId } = (await post(sid, { ciphertext: 'p' })).json;
    const offer = offerFor(await d.claim('work'), sid);
    await d.received(offer.deliveryId);
    await d.submitted(turnId);
    // The daemon archives the session (window closed) …
    expect((await d.card(sid, { state: 'archived' })).status).toBe(200);
    // … and its already-pending start request lands afterwards.
    const late = await d.start(turnId, { runtimeEventId: randomUUID() });
    expect(late.status).toBe(409);
    expect(late.json.error).toBe('session_archived');
    const st = (await call('GET', `/joy/v2/sessions/${sid}`)).json;
    expect(st.sessionState).toBe('archived');
    // A closed session takes no new prompts either.
    expect((await post(sid, { ciphertext: 'again' })).status).toBe(409);
  });

  it('archiving resolves queued work in the same transaction: cancelled turns, superseded deliveries, nothing offered', async () => {
    const d = makeDaemon('mach-614b'); await d.acquire();
    const sid = await makeSession(d);
    const a = (await post(sid, { ciphertext: 'a' })).json;
    const b = (await post(sid, { ciphertext: 'b' })).json;
    const offer = offerFor(await d.claim('work'), sid); // head A offered, not yet acked
    expect((await d.card(sid, { state: 'archived' })).status).toBe(200);
    expect((await getMsg(sid, a.messageId)).json.status).toBe('cancelled');
    expect((await getMsg(sid, b.messageId)).json.status).toBe('cancelled');
    // The delivery the daemon holds is refused; a fresh claim offers nothing.
    expect((await d.received(offer.deliveryId)).status).toBe(409);
    expect(offerFor(await d.claim('work'), sid)).toBeUndefined();
    const submit = await d.submitted(offer.turnId);
    expect(submit.status).toBe(409);
  });
});

describe('#620 reordering never strands an acknowledged delivery', () => {
  it('an acknowledged head stays fixed ahead; the moved message queues behind it and the head still starts', async () => {
    const d = makeDaemon('mach-620a'); await d.acquire();
    const sid = await makeSession(d);
    const a = (await post(sid, { ciphertext: 'A' })).json;
    const b = (await post(sid, { ciphertext: 'B' })).json;
    const c = (await post(sid, { ciphertext: 'C' })).json;
    const offer = offerFor(await d.claim('work'), sid);
    expect(offer.turnId).toBe(a.turnId);
    await d.received(offer.deliveryId); // A acked: "delivering", payload in the daemon's hands
    // The user drags C to the front.
    const moved = await call('PATCH', `/joy/v2/sessions/${sid}/messages/${c.messageId}`, { body: { position: 0 } });
    expect(moved.status).toBe(200);
    const order = (await call('GET', `/joy/v2/sessions/${sid}/messages`)).json.messages.map((m) => m.ciphertext);
    expect(order).toEqual(['A', 'C', 'B']); // A still first; C moved ahead of B only
    // A proceeds normally — no not_queue_head, no occupied slot.
    expect((await d.submitted(a.turnId)).status).toBe(200);
    expect((await d.start(a.turnId, { runtimeEventId: randomUUID() })).status).toBe(200);
    await d.fact(a.turnId, { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() });
    expect(offerFor(await d.claim('work'), sid).turnId).toBe(c.turnId);
    void b;
  });

  it('an offered-but-unacknowledged head that gets displaced is superseded, and the daemon re-claims the new head', async () => {
    const d = makeDaemon('mach-620b'); await d.acquire();
    const sid = await makeSession(d);
    const a = (await post(sid, { ciphertext: 'A' })).json;
    const b = (await post(sid, { ciphertext: 'B' })).json;
    const offer = offerFor(await d.claim('work'), sid); // A offered, NOT acked
    expect(offer.turnId).toBe(a.turnId);
    expect((await call('PATCH', `/joy/v2/sessions/${sid}/messages/${b.messageId}`, { body: { position: 0 } })).status).toBe(200);
    // The stale claim is refused at /received (same discipline as an edit, #57) …
    const ack = await d.received(offer.deliveryId);
    expect(ack.status).toBe(409);
    expect(ack.json.error).toBe('delivery_superseded');
    // … and the next claim carries the true head.
    const next = offerFor(await d.claim('work'), sid);
    expect(next.turnId).toBe(b.turnId);
    await d.received(next.deliveryId);
    await d.submitted(b.turnId);
    expect((await d.start(b.turnId, { runtimeEventId: randomUUID() })).status).toBe(200);
  });
});

describe('#621 a queued-only delete is decided inside the cancellation transaction', () => {
  it('a turn that started after the client read it as queued is left running; nothing rides the control lane', async () => {
    const d = makeDaemon('mach-621'); await d.acquire();
    const sid = await makeSession(d);
    const { messageId, turnId } = (await post(sid, { ciphertext: 'p' })).json;
    // The client observed "queued" …
    expect((await getMsg(sid, messageId)).json.status).toBe('queued');
    // … then the daemon acked, submitted and started before the cancel ran.
    const offer = offerFor(await d.claim('work'), sid);
    await d.received(offer.deliveryId);
    await d.submitted(turnId);
    await d.start(turnId, { runtimeEventId: randomUUID() });
    // The cancellation transaction re-checks the precondition itself.
    const err = await core.acceptCancellation('account-1', 'tok:test', sid, turnId,
      { clientIntentId: randomUUID(), scope: 'turn' }, { requireQueued: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
    expect(err.code).toEqual({ error: 'not_deletable', status: 'delivered' });
    const turn = (await call('GET', `/joy/v2/sessions/${sid}/turns/${turnId}`)).json;
    expect(turn).toMatchObject({ state: 'running', cancelRequested: false });
    expect((await d.claim('control')).filter((o) => o.sessionId === sid)).toEqual([]);
    // The route reports the same refusal, with the live status.
    const del = await call('DELETE', `/joy/v2/sessions/${sid}/messages/${messageId}`);
    expect(del.status).toBe(409);
    expect(del.json).toEqual({ error: 'not_deletable', status: 'delivered' });
  });

  it('an acknowledged (not yet started) message is not deletable either', async () => {
    const d = makeDaemon('mach-621b'); await d.acquire();
    const sid = await makeSession(d);
    const { messageId } = (await post(sid, { ciphertext: 'p' })).json;
    const offer = offerFor(await d.claim('work'), sid);
    await d.received(offer.deliveryId);
    const del = await call('DELETE', `/joy/v2/sessions/${sid}/messages/${messageId}`);
    expect(del.status).toBe(409);
    expect(del.json).toEqual({ error: 'not_deletable', status: 'delivering' });
  });
});

describe('#58 one attachment, several prompts', () => {
  it('every prompt that cites the blob is authorized in its own offer; the blob stays pinned while any reference exists', async () => {
    const d = makeDaemon('mach-58'); await d.acquire();
    const sid = await makeSession(d);
    const bytes = Buffer.from('shared-screenshot');
    const up = await call('POST', '/joy/v2/attachments', { raw: bytes, headers: { 'x-session': sid } });
    expect(up.status).toBe(201);
    const id = up.json.attachmentId;
    const again = await call('POST', '/joy/v2/attachments', { raw: bytes, headers: { 'x-session': sid } });
    expect(again.status).toBe(200);
    expect(again.json.attachmentId).toBe(id);
    const m1 = (await post(sid, { ciphertext: 'first look', attachments: [id] })).json;
    const m2 = (await post(sid, { ciphertext: 'second look', attachments: [id] })).json;
    const o1 = offerFor(await d.claim('work'), sid);
    expect(o1.turnId).toBe(m1.turnId);
    expect(o1.attachments).toEqual([{ id, size: bytes.length }]);
    // Cancel the first before it runs — the second must still be authorized.
    expect((await call('DELETE', `/joy/v2/sessions/${sid}/messages/${m1.messageId}`)).status).toBe(200);
    const o2 = offerFor(await d.claim('work'), sid);
    expect(o2.turnId).toBe(m2.turnId);
    expect(o2.attachments).toEqual([{ id, size: bytes.length }]);
    // Aged past the TTL, a referenced blob survives the sweep.
    await db.query(`UPDATE attachments SET uploaded_at = now() - interval '2 days', created_at = now() - interval '2 days' WHERE id = $1`, [id]);
    await attachments.sweepOrphans();
    expect((await call('GET', `/joy/v2/attachments/${id}`)).status).toBe(200);
  });
});

describe('#611 a retried upload renews the orphan clock', () => {
  it('an aged unreferenced blob re-uploaded just now survives the next sweep and can be cited', async () => {
    const d = makeDaemon('mach-611'); await d.acquire();
    const sid = await makeSession(d);
    const bytes = Buffer.from('slow-client-retry');
    const first = await call('POST', '/joy/v2/attachments', { raw: bytes, headers: { 'x-session': sid } });
    const id = first.json.attachmentId;
    await db.query(`UPDATE attachments SET uploaded_at = now() - interval '2 days', created_at = now() - interval '2 days' WHERE id = $1`, [id]);
    // The client retries the identical upload (network blip) and is told "ok, same id".
    const retry = await call('POST', '/joy/v2/attachments', { raw: bytes, headers: { 'x-session': sid } });
    expect(retry.status).toBe(200);
    expect(retry.json.attachmentId).toBe(id);
    // The hourly sweep runs before the client's message lands.
    expect(await attachments.sweepOrphans()).toBe(0);
    expect((await call('GET', `/joy/v2/attachments/${id}`)).status).toBe(200);
    expect((await post(sid, { ciphertext: 'see attached', attachments: [id] })).status).toBe(202);
  });
});

describe('#619 SSE greeting: a client gone during the snapshot arms no heartbeat', () => {
  it('disconnecting while listSessions is pending creates no interval; a live client gets one that is cleared on close', async () => {
    const setSpy = vi.spyOn(globalThis, 'setInterval');
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    const original = core.listSessions;
    core.listSessions = async (...args) => { await sleep(250); return original(...args); };
    try {
      const heartbeats = () => setSpy.mock.calls.filter((c) => c[1] === 15_000).length;
      const before = heartbeats();
      // Gone during the read.
      const ac = new AbortController();
      const gone = fetch(`${base}/joy/v2/events/stream`, { headers: { authorization: 'Bearer app-token' }, signal: ac.signal });
      await sleep(50);
      ac.abort();
      await gone.catch(() => {});
      await sleep(400);
      expect(heartbeats()).toBe(before);
      // Live client: greeted, one heartbeat, cleared when it leaves.
      const ac2 = new AbortController();
      const live = await fetch(`${base}/joy/v2/events/stream`, { headers: { authorization: 'Bearer app-token' }, signal: ac2.signal });
      const reader = live.body.getReader();
      const { value } = await reader.read();
      expect(Buffer.from(value).toString()).toContain('event: hello');
      expect(heartbeats()).toBe(before + 1);
      const armed = setSpy.mock.results.at(-1).value;
      ac2.abort();
      await sleep(100);
      expect(clearSpy.mock.calls.some((c) => c[0] === armed)).toBe(true);
    } finally {
      core.listSessions = original;
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
