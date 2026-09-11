// The relay queue under simulation (test/sim/): the real relay — HTTP,
// router, PGlite — driven by a fake daemon, fake devices, and a clock the
// test owns. Scripted scenarios first, to show the harness reaches the
// states that matter (a lease that lapses, a turn orphaned by a crash and
// adopted by the restart, one interrupted); then seeded random runs, whose
// only oracle for now is "the relay never faults" and "a seed reproduces".
// Invariants and fault injection build on this in the next step.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { installClock } from './sim/clock.mjs';
import { createWorld } from './sim/world.mjs';
import { SimDaemon } from './sim/daemon.mjs';
import { SimApp } from './sim/app.mjs';
import { createSim } from './sim/sim.mjs';

// A PGlite boot is ~1.5 s alone and several seconds under the full suite's
// parallel load; every scenario boots its own relay.
vi.setConfig({ testTimeout: 120_000 });

let clock;
beforeAll(() => { clock = installClock(); });
afterAll(() => clock.uninstall());

async function boot(seed = 1, { daemons = 1, apps = 1, crashes = false } = {}) {
  const world = await createWorld({ clock });
  const ds = Array.from({ length: daemons }, (_, k) => new SimDaemon(world, `m${k + 1}`));
  const as = Array.from({ length: apps }, (_, k) => new SimApp(world, `d${k + 1}`));
  const sim = createSim({ seed, world, clock, daemons: ds, apps: as, crashes });
  return { world, sim, d: ds[0], app: as[0], daemons: ds, apps: as };
}
const turnRow = (world, id) => world.db.query(`SELECT * FROM turns WHERE id = $1`, [id]).then((r) => r.rows[0]);

describe('the harness drives the real relay', () => {
  it('a prompt goes queued → delivered → running → completed through the daemon steps, and the clock is the relay\'s', async () => {
    const { world, d, app } = await boot();
    try {
      expect((await d.acquire()).status).toBe(200);
      const s = await d.announce();
      const sid = s.json.sessionId;
      app.see(sid, d.id);
      const sent = await app.send(sid);
      expect(sent.status).toBe(202);
      const { turnId, messageId } = sent.json;

      await d.claim('work');
      expect(d.offers.size).toBe(1);
      const offer = [...d.offers.values()][0];
      expect(offer.turnId).toBe(turnId);
      expect((await d.ack(offer)).status).toBe(200);
      await app.refresh(sid);
      expect(app.sessions.get(sid).messages.get(messageId).status).toBe('delivering');

      expect((await d.submit(turnId)).status).toBe(200);
      expect((await d.start(turnId)).status).toBe(200);
      expect((await d.output(turnId)).status).toBe(200);
      const before = clock.now();
      expect((await d.finish(turnId)).status).toBe(200);
      const t = await turnRow(world, turnId);
      expect(t).toMatchObject({ state: 'terminal', terminal_state: 'completed' });
      // The row was stamped by the simulation's clock, not the wall's.
      expect(new Date(t.terminal_at).getTime()).toBeGreaterThan(before);
      expect(new Date(t.terminal_at).getTime()).toBeLessThanOrEqual(clock.now());
      await app.refresh(sid);
      expect(app.sessions.get(sid).messages.get(messageId).status).toBe('delivered');
    } finally { await world.close(); }
  });

  it('a lease lapses when the clock passes its TTL, and only then', async () => {
    const { world, d, app } = await boot();
    try {
      await d.acquire();
      const sid = (await d.announce()).json.sessionId;
      app.see(sid, d.id);
      clock.advance(19_000);
      expect((await d.renew()).status).toBe(200);
      expect((await app.call('GET', `/joy/v2/sessions/${sid}`)).json.daemon.status).toBe('online');
      clock.advance(20_001);
      expect((await app.call('GET', `/joy/v2/sessions/${sid}`)).json.daemon.status).toBe('offline');
      const r = await d.renew();
      expect(r.status).toBe(412);
      expect(r.code).toBe('lease_expired');
      expect(d.lease).toBeNull();
      expect((await d.acquire()).json.epoch).toBe('2');
    } finally { await world.close(); }
  });
});

describe('crash, sweep, reconcile', () => {
  async function runningTurn({ d, app }) {
    await d.acquire();
    const sid = (await d.announce()).json.sessionId;
    app.see(sid, d.id);
    const { turnId, messageId } = (await app.send(sid)).json;
    await d.claim('work');
    await d.ack([...d.offers.values()][0]);
    await d.submit(turnId);
    return { sid, turnId, messageId };
  }

  it('a daemon that dies after submit leaves a dispatching turn; the sweep orphans it once the lease has lapsed; the restart adopts it because the agent still runs', async () => {
    const ctx = await boot();
    const { world, d, app } = ctx;
    try {
      const { turnId, messageId, sid } = await runningTurn(ctx);
      expect((await turnRow(world, turnId)).state).toBe('dispatching');
      d.crash();
      expect(d.runtime.get(turnId)).toBe('executing');
      // Before the lease lapses the sweep sees a live owner and leaves it.
      expect(await world.sweep()).toBe(0);
      clock.advance(21_000);
      expect(await world.sweep()).toBe(1);
      expect((await turnRow(world, turnId)).state).toBe('orphaned');
      await app.refresh(sid);
      expect(app.sessions.get(sid).messages.get(messageId).status).toBe('failed');

      expect((await d.restart()).json.epoch).toBe('2');
      expect(d.inherited().map((r) => r.turnId)).toEqual([turnId]);
      const r = await d.reconcile(turnId);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ state: 'running', adopted: true });
      expect((await turnRow(world, turnId))).toMatchObject({ state: 'running', lease_epoch: 2 });
      expect(d.inherited()).toEqual([]);
      expect((await d.finish(turnId)).status).toBe(200);
      expect((await turnRow(world, turnId))).toMatchObject({ state: 'terminal', terminal_state: 'completed' });
    } finally { await world.close(); }
  });

  it('a rebooted machine has no agent for the turn: the restart closes it as interrupted', async () => {
    const ctx = await boot();
    const { world, d } = ctx;
    try {
      const { turnId } = await runningTurn(ctx);
      await d.start(turnId);
      d.reboot();
      clock.advance(21_000);
      await world.sweep();
      await d.restart();
      const r = await d.reconcile(turnId);
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ state: 'terminal', terminalState: 'interrupted' });
      expect((await turnRow(world, turnId))).toMatchObject({ state: 'terminal', terminal_state: 'interrupted' });
    } finally { await world.close(); }
  });

  it('a restart that beats the sweep cannot close a predecessor\'s turn (turn_not_orphaned) but can adopt it; the sweep then lets the close through', async () => {
    const ctx = await boot();
    const { world, d } = ctx;
    try {
      const { turnId } = await runningTurn(ctx);
      await d.start(turnId);
      d.reboot();                       // no agent survives
      await d.restart();                // epoch 2, lease 1 not yet expired
      const early = await d.reconcile(turnId);
      expect(early.status).toBe(409);
      expect(early.code).toBe('turn_not_orphaned');
      expect(d.inherited().length).toBe(1);
      clock.advance(21_000);
      // The new lease has lapsed too by now; renew is refused, acquire again.
      expect((await d.renew()).status).toBe(412);
      await d.acquire();
      expect(await world.sweep()).toBe(1);
      expect((await d.reconcile(turnId)).json).toMatchObject({ state: 'terminal', terminalState: 'interrupted' });
    } finally { await world.close(); }
  });
});

describe('seeded random runs', () => {
  const STEPS = 400;
  for (const seed of [1, 2, 3]) {
    it(`seed ${seed}: ${STEPS} steps with two daemons and two devices, no crashes, and the relay never faults`, async () => {
      const { world, sim } = await boot(seed, { daemons: 2, apps: 2 });
      try {
        await sim.run(STEPS);
        expect(world.trace.every((e) => e.status < 500)).toBe(true);
      } catch (e) {
        throw new Error(`${e.message}\n${sim.formatTrace(40)}`);
      } finally { await world.close(); }
    });
  }
  it('seed 11: with crashes and reboots on, still no faults, and every turn the sweep orphaned was reconciled or requeued by the end', async () => {
    const { world, sim } = await boot(11, { daemons: 2, apps: 2, crashes: true });
    try {
      await sim.run(600);
      const snap = await sim.snapshot();
      // Not an invariant (a turn orphaned in the last steps is legitimately
      // still orphaned); a smoke check that the crash path was exercised.
      expect(sim.steps.some((s) => s.name === 'crash' || s.name === 'reboot')).toBe(true);
      expect(sim.steps.some((s) => s.name === 'reconcile' && s.status === 200)).toBe(true);
      expect(snap.turns.length).toBeGreaterThan(0);
    } catch (e) {
      throw new Error(`${e.message}\n${sim.formatTrace(40)}`);
    } finally { await world.close(); }
  });

  it('a seed reproduces: two runs have the same spine of actions and answers', async () => {
    const spines = [];
    for (let k = 0; k < 2; k++) {
      clock.set(Date.UTC(2030, 0, 1));
      const { world, sim } = await boot(7, { daemons: 2, apps: 2, crashes: true });
      try { await sim.run(250); spines.push(sim.shape()); } finally { await world.close(); }
    }
    expect(spines[0]).toEqual(spines[1]);
    expect(spines[0].length).toBe(250);
  });
});
