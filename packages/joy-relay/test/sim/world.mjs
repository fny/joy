// The world the actors act in: one in-process relay (real HTTP, real PGlite
// in memory, the real router) with the simulation's clock underneath it, and
// one `call` that every actor goes through. Every request ticks the clock by
// a millisecond and lands in the trace, so a failing run can be read back
// request by request.
//
// No vitest here: the same world runs under `node test/sim/run.mjs` for long
// campaigns. Nothing is faked below the HTTP line — the point is that the
// code under test is the relay that ships.
import * as http from 'node:http';
import { openDb } from '../../src/db.mjs';
import { createCore } from '../../src/core.mjs';
import { createNotify } from '../../src/notify.mjs';
import { createV2Router } from '../../src/v2.mjs';
import { createTunnel } from '../../src/tunnel.mjs';
import { createAttachments } from '../../src/attachments.mjs';

export const ACCOUNT_TOKENS = new Map([['app-token', 'account-1'], ['other-token', 'account-2']]);

/** Thrown when the relay answers with a 5xx or the request itself fails:
 *  a simulation never continues past one, and the trace up to it is the
 *  reproduction. */
export class RelayFault extends Error {
  constructor(message, entry) { super(message); this.entry = entry; }
}

export async function createWorld({ clock }) {
  const db = await openDb(':memory:');
  const notify = createNotify();
  const core = createCore(db, notify);
  const auth = { verifyToken: async (t) => ACCOUNT_TOKENS.get(t) ?? null };
  const tunnel = createTunnel({ notify });
  const attachments = createAttachments(db);
  const v2 = createV2Router({ core, auth, notify, db, tunnel, attachments });
  const server = http.createServer(async (req, res) => {
    if (await v2.handle(req, res)) return;
    res.writeHead(599); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const trace = [];
  let step = 0;
  /** Where a fault-injection hook will sit (step 3): a function that sees the
   *  request before it goes out and the response before the actor does. */
  const faults = { before: null, after: null };

  async function call(actor, method, path, { body, token = 'app-token', headers = {} } = {}) {
    clock.advance(1);
    const entry = { step, actor, method, path, body: body ?? null, at: clock.now() };
    if (faults.before) await faults.before(entry);
    let r;
    try {
      r = await fetch(base + path, {
        method,
        // One connection per request: keep-alive reuse is decided by wall
        // clocks on both ends, and the sim's clock is not the wall's — a
        // socket the server had already closed came back as "fetch failed".
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, connection: 'close', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      entry.error = String(e?.message ?? e);
      trace.push(entry);
      throw new RelayFault(`transport failure on ${method} ${path}: ${entry.error}`, entry);
    }
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    entry.status = r.status;
    entry.json = json;
    trace.push(entry);
    if (r.status >= 500) throw new RelayFault(`relay answered ${r.status} on ${method} ${path}: ${text.slice(0, 300)}`, entry);
    if (faults.after) await faults.after(entry);
    return { status: r.status, json, code: typeof json?.error === 'string' ? json.error : json?.error?.error ?? null };
  }

  return {
    base, db, core, notify, attachments, trace, faults, clock,
    call,
    beginStep: (n) => { step = n; },
    /** The relay's own timers, driven by hand. */
    sweep: () => core.sweepExpiredLeases(),
    async close() { server.close(); await db.close(); },
  };
}
