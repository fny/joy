// The v2 router's error path: an internal error is ANSWERED (500
// internal_error, logged), never mistaken for a client that left. Node
// destroys the request stream once its body has been consumed, and the old
// client-abort test read that as "nobody to answer" — every internal error
// thrown after readJson() reset the socket silently. Found by the simulator.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { startRelay } from './harness.mjs';

let relay;
beforeAll(async () => { relay = await startRelay(); });
afterAll(() => relay.close());

describe('router internal errors', () => {
  it('an error thrown after the JSON body was read answers 500 internal_error and is logged — not a socket reset', async () => {
    const d = relay.makeDaemon('mach-router'); await d.acquire();
    const orig = relay.core.reconcileTurn;
    relay.core.reconcileTurn = async () => { throw new TypeError('synthetic internal error'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await relay.call('POST', '/joy/v2/daemon/turns/some-turn/reconcile', { body: { resolution: 'running' }, headers: d.headers() });
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ error: 'internal_error' });
      expect(err).toHaveBeenCalledWith('[joy-relay v2] internal error:', expect.any(TypeError));
    } finally {
      relay.core.reconcileTurn = orig;
      err.mockRestore();
    }
  });

  it('a GET (no body to read) behaves the same', async () => {
    const orig = relay.core.listSessions;
    relay.core.listSessions = async () => { throw new Error('boom'); };
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const r = await relay.call('GET', '/joy/v2/sessions');
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ error: 'internal_error' });
    } finally { relay.core.listSessions = orig; err.mockRestore(); }
  });
});
