// The step engine. A simulation is a world, a clock, some daemons, some
// devices, and a seed. Each step: collect every action every actor could
// take right now, pick one by weight, run it, record what happened. Time and
// the relay's own timers are actors too (`env`), so a lease expiring or a
// sweep running is a step the trace shows, never something that happened
// underneath.
//
// Actions never throw on a 4xx. The engine stops on a RelayFault (a 5xx or a
// dead socket) and on any exception an actor lets out; the trace up to that
// point is the reproduction, and the seed regenerates it.
import { createRng } from './prng.mjs';
import { RelayFault, LostResponse } from './world.mjs';
import { checkInvariants } from './invariants.mjs';
import { checkContract } from './conformance.mjs';

/** Relative frequencies by action name. Crashes are opt-in (see `crashes`)
 *  — they are a fault model, not the baseline. */
export const DEFAULT_WEIGHTS = {
  // environment
  advance: 6, sweep: 2, runtimeFinish: 2, crash: 1, reboot: 0.5,
  // daemon
  acquire: 5, restart: 3, renew: 3, claimWork: 6, claimControl: 2, announce: 1,
  bind: 2, spawnFail: 0.3, ack: 5, submit: 4, start: 4, output: 2, finish: 3, archive: 0.4, reconcile: 4,
  // app
  spawn: 0.4, send: 4, refresh: 2, edit: 1, remove: 1, move: 1, cancel: 1, retry: 1, retrySpawn: 1,
};
/** How far one `advance` step moves the clock. 21 s is past the lease TTL. */
export const ADVANCE_STEPS_MS = [100, 500, 1000, 4000, 4000, 21_000];

/** Fault model, all opt-in and all off by default:
 *  - `crashes`      crash/reboot actions in the generator
 *  - `lostResponse` probability a relay answer never reaches the actor
 *  - `lostRequest`  probability a request never reaches the relay
 *  - `crashOnLoss`  probability that a daemon whose answer was lost died
 *                   in the same instant (the request-in-flight crash window)
 *  - `invariants`   check the invariants after every step (default on);
 *                   `checkEvery` thins it for long campaigns */
export function createSim({
  seed, world, clock, daemons, apps, weights = {},
  crashes = false, lostResponse = 0, lostRequest = 0, crashOnLoss = 0,
  invariants = true, checkEvery = 1,
}) {
  const rng = createRng(seed);
  const W = { ...DEFAULT_WEIGHTS, ...weights };
  const steps = [];
  let i = 0;
  const daemonByLabel = new Map(daemons.map((d) => [d.label, d]));

  // Faults are decided by the seed, one draw per request, so a run with the
  // same seed loses the same answers.
  const faultRng = createRng(seed ^ 0x5f3759df);
  world.faults.before = lostRequest > 0 ? () => faultRng.chance(lostRequest) : null;
  world.faults.after = lostResponse > 0 ? () => faultRng.chance(lostResponse) : null;

  function envActions() {
    const A = [
      { name: 'advance', run: () => { const ms = rng.pick(ADVANCE_STEPS_MS); clock.advance(ms); return { status: 0, code: `+${ms}ms` }; } },
      { name: 'sweep', run: async () => ({ status: 0, code: `orphaned:${await world.sweep()}` }) },
    ];
    for (const d of daemons) {
      // An agent finishing while its daemon is down: nobody reports it.
      if (!d.alive) {
        for (const [turnId, st] of d.runtime) {
          if (st === 'executing') A.push({ name: 'runtimeFinish', detail: turnId, run: () => { d.runtime.set(turnId, 'done'); return { status: 0, code: 'done' }; } });
        }
      } else if (crashes) {
        A.push({ name: 'crash', detail: d.id, run: () => d.crash() });
        A.push({ name: 'reboot', detail: d.id, run: () => d.reboot() });
      }
    }
    return A.map((a) => ({ ...a, actor: 'env' }));
  }

  function enabled() {
    const daemonIds = daemons.map((d) => d.id);
    const all = [...envActions()];
    for (const d of daemons) for (const a of d.actions()) all.push({ ...a, actor: d.label });
    for (const app of apps) for (const a of app.actions(daemonIds)) all.push({ ...a, actor: app.label });
    return all.map((a) => ({ ...a, weight: W[a.name] ?? 1 })).filter((a) => a.weight > 0);
  }

  /** Every device learns of every session on the account (the relay's
   *  session list does this for real devices on their next sync). */
  function syncDevices() {
    for (const d of daemons) for (const [sid] of d.records) for (const app of apps) app.see(sid, d.id);
    for (const a of apps) for (const [sid, s] of a.sessions) for (const b of apps) b.see(sid, s.daemonId, s.state);
  }

  /** Pick by NAME first, then uniformly among that name's instances: a
   *  device with forty queued messages must not drown the daemon's four
   *  lifecycle steps under a hundred and twenty edits. */
  function choose() {
    const groups = new Map();
    for (const a of enabled()) { const g = groups.get(a.name) ?? []; g.push(a); groups.set(a.name, g); }
    const names = [...groups.keys()].map((name) => ({ name, weight: W[name] ?? 1 }));
    const g = groups.get(rng.weighted(names).name);
    return rng.pick(g);
  }

  async function step() {
    const a = choose();
    world.beginStep(i);
    const traceStart = world.trace.length;
    const rec = { i, actor: a.actor, name: a.name, detail: a.detail ?? null, at: clock.now() };
    try {
      const r = await a.run(rng);
      rec.status = r?.status ?? 0;
      rec.code = r?.code ?? null;
    } catch (e) {
      if (e instanceof LostResponse) {
        // The actor is left exactly as the call found it (its methods only
        // move state on an answer — except where the real daemon commits
        // first, and that is modelled the same way). A daemon may also have
        // died in the same instant.
        rec.status = 'lost';
        rec.code = e.phase;
        const d = daemonByLabel.get(a.actor);
        if (d && e.phase === 'after' && crashOnLoss > 0 && faultRng.chance(crashOnLoss)) { d.crash(); rec.code = 'after+crash'; }
      } else {
        rec.error = e instanceof RelayFault ? e.message : `${e?.stack ?? e}`;
        steps.push(rec);
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sim: api });
      }
    }
    steps.push(rec);
    syncDevices();
    try {
      for (const entry of world.trace.slice(traceStart)) if (!entry.lost) checkContract(entry);
      if (invariants && (i % checkEvery === 0 || a.name === 'sweep')) await checkInvariants(world, { daemons, apps }, { afterAction: a.name });
    } catch (e) {
      rec.error = e.message;
      throw Object.assign(e, { sim: api });
    }
    i++;
    return rec;
  }

  async function run(n) { for (let k = 0; k < n; k++) await step(); return steps; }

  /** The id-free spine of a run: what was done and what came back. Two runs
   *  with one seed must produce the same spine — ids differ, this must not. */
  const shape = () => steps.map((s) => `${s.actor} ${s.name} → ${s.status} ${s.code ?? ''}`.trim());

  function formatTrace(last = 40) {
    return steps.slice(-last).map((s) =>
      `#${String(s.i).padStart(4)} ${s.actor.padEnd(16)} ${s.name.padEnd(14)} ${(s.detail ?? '').slice(0, 12).padEnd(12)} → ${s.status} ${s.code ?? ''}${s.error ? `\n      ${s.error}` : ''}`).join('\n');
  }

  /** The relay's state, as rows: for assertions now and invariants later. */
  async function snapshot() {
    const q = async (sql) => (await world.db.query(sql)).rows;
    return {
      sessions: await q(`SELECT id, state, owner_daemon_id, active_turn_id, recovery_required, local_session_id FROM native_sessions ORDER BY created_at`),
      turns: await q(`SELECT id, session_id, state, terminal_state, lease_epoch, cancel_requested, request_seq FROM turns ORDER BY created_at`),
      commands: await q(`SELECT id, session_id, kind, state, disposition, turn_id, target_turn_id FROM commands ORDER BY created_at`),
      deliveries: await q(`SELECT id, command_id, daemon_id, lease_epoch, lane, attempt, received_at, submitted_at, disposition FROM deliveries ORDER BY offered_at`),
      leases: await q(`SELECT id, daemon_id, account_id, epoch, expires_at, released_at FROM daemon_leases ORDER BY acquired_at`),
    };
  }

  const api = { rng, steps, step, run, shape, formatTrace, snapshot, enabled, clock, world, daemons, apps };
  return api;
}
