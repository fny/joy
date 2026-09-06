// Wave F (review campaign 2026-09) — conditional session delete (#173).
// The app's folder cleanup used to delete the record of a session whose
// agent was still working. Stopping first is the app's job; the relay's is
// to make the delete itself conditional so a stale card or a lost kill can
// never remove a live session's history: `?ifStatus=a,b` → 409
// status_mismatch (with the current state) unless the record is in one of
// those states AT the delete. Mirrors the daemon kill's `ifStatus`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startRelay } from './harness.mjs';

let relay, base, call, makeDaemon, makeSession;

beforeAll(async () => {
  relay = await startRelay();
  ({ base, call, makeDaemon, makeSession } = relay);
});
afterAll(() => relay.close());

const NOT_LIVE = 'detached,archived,failed';

describe('#173 DELETE /sessions/:id honours ifStatus', () => {
  it('a live session is refused with 409 status_mismatch and keeps its record; an archived one goes', async () => {
    const d = makeDaemon('mach-173'); await d.acquire();
    const sid = await makeSession(d);
    // announce_existing creates the record 'starting'; the daemon's card
    // publish makes it 'active' — a session with a live agent behind it.
    expect((await d.card(sid, { state: 'active', encryptedMetadata: 'card' })).status).toBe(200);
    const refused = await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=${NOT_LIVE}`);
    expect(refused.status).toBe(409);
    expect(refused.json).toEqual({ error: 'status_mismatch', status: 'active' });
    // Nothing was deleted: the record, its card and its events are intact.
    const still = await call('GET', `/joy/v2/sessions/${sid}`);
    expect(still.status).toBe(200);
    expect(still.json.sessionState).toBe('active');
    expect((await call('GET', '/joy/v2/sessions')).json.sessions.some((s) => s.sessionId === sid)).toBe(true);
    // The agent is stopped (the daemon archives the card) — now the same delete succeeds.
    expect((await d.card(sid, { state: 'archived' })).status).toBe(200);
    const ok = await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=${NOT_LIVE}`);
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true });
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).status).toBe(404);
  });

  it('a session that restarted between the read and the delete is kept (the precondition is checked at the delete)', async () => {
    const d = makeDaemon('mach-173b'); await d.acquire();
    const sid = await makeSession(d);
    await d.card(sid, { state: 'detached' });
    // The app read "detached" and decided to delete … but the session came back.
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).json.sessionState).toBe('detached');
    await d.card(sid, { state: 'active' });
    const r = await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=detached`);
    expect(r.status).toBe(409);
    expect(r.json.status).toBe('active');
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).status).toBe(200);
  });

  it('a single state, a list, and the not-live set all work; a starting (unbound) session counts as live', async () => {
    const d = makeDaemon('mach-173c'); await d.acquire();
    const sid = await makeSession(d); // 'starting'
    expect((await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=${NOT_LIVE}`)).status).toBe(409);
    expect((await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=archived`)).status).toBe(409);
    expect((await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=starting,active`)).status).toBe(200);
  });

  it('an unknown state name is 400 bad_ifStatus and deletes nothing; no ifStatus is unconditional, as before', async () => {
    const d = makeDaemon('mach-173d'); await d.acquire();
    const sid = await makeSession(d);
    await d.card(sid, { state: 'active' });
    for (const bad of ['ended', ',', 'Active', '']) {
      const r = await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=${encodeURIComponent(bad)}`);
      expect(r.status, bad).toBe(400);
      expect(r.json.error).toBe('bad_ifStatus');
    }
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).status).toBe(200);
    expect((await call('DELETE', `/joy/v2/sessions/${sid}`)).status).toBe(200);
    expect((await call('GET', `/joy/v2/sessions/${sid}`)).status).toBe(404);
  });

  it('another account cannot probe a session state through the precondition', async () => {
    const d = makeDaemon('mach-173e'); await d.acquire();
    const sid = await makeSession(d);
    const r = await call('DELETE', `/joy/v2/sessions/${sid}?ifStatus=archived`, { token: 'other-token' });
    expect(r.status).toBe(404); // not 409: ownership is settled first
    expect(r.json.error).toBe('session_not_found');
  });
});
