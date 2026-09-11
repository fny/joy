#!/usr/bin/env node
// Campaign runner: node test/sim/run.mjs --seed 1 --steps 2000 [--seeds 20] [--crashes] [--daemons 2] [--apps 2] [--hist]
// Runs each seed to completion or to the first fault, and prints the
// trace tail of a failing seed. `--hist` prints what each seed did: a
// histogram of action → answer, and the turns by final state. Exit 1 on
// any fault.
import { installClock } from './clock.mjs';
import { createWorld } from './world.mjs';
import { SimDaemon } from './daemon.mjs';
import { SimApp } from './app.mjs';
import { createSim } from './sim.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const flag = (name) => argv.includes(`--${name}`);
const seed0 = Number(opt('seed', 1));
const seeds = Number(opt('seeds', 1));
const stepsN = Number(opt('steps', 1000));
const nDaemons = Number(opt('daemons', 2));
const nApps = Number(opt('apps', 2));
const crashes = flag('crashes');
const hist = flag('hist');

function printHistogram(sim, snap) {
  const h = new Map();
  for (const s of sim.steps) { const k = `${s.name.padEnd(14)} → ${s.status} ${s.code ?? ''}`; h.set(k, (h.get(k) ?? 0) + 1); }
  for (const [k, n] of [...h].sort()) console.log(String(n).padStart(6), k);
  const byState = {};
  for (const t of snap.turns) { const k = t.state + (t.terminal_state ? `:${t.terminal_state}` : ''); byState[k] = (byState[k] ?? 0) + 1; }
  console.log('  turns:', JSON.stringify(byState));
}

const clock = installClock();
let failed = 0;
for (let seed = seed0; seed < seed0 + seeds; seed++) {
  const world = await createWorld({ clock });
  const daemons = Array.from({ length: nDaemons }, (_, k) => new SimDaemon(world, `m${k + 1}`));
  const apps = Array.from({ length: nApps }, (_, k) => new SimApp(world, `d${k + 1}`));
  const sim = createSim({ seed, world, clock, daemons, apps, crashes });
  const t0 = process.hrtime.bigint();
  try {
    await sim.run(stepsN);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const snap = await sim.snapshot();
    const terminal = snap.turns.filter((t) => t.state === 'terminal').length;
    console.log(`seed ${seed}: ${stepsN} steps ok in ${ms.toFixed(0)} ms — ${snap.sessions.length} sessions, ${snap.turns.length} turns (${terminal} terminal), ${snap.leases.length} leases, ${world.trace.length} requests`);
    if (hist) printHistogram(sim, snap);
  } catch (e) {
    failed++;
    console.log(`seed ${seed}: FAULT at step ${sim.steps.length - 1}: ${e.message}`);
    console.log(sim.formatTrace(60));
    if (e.entry) console.log('request:', JSON.stringify(e.entry, null, 1).slice(0, 2000));
  } finally {
    await world.close();
  }
}
clock.uninstall();
process.exit(failed ? 1 : 0);
