#!/usr/bin/env node
// One-harness live e2e over the v2 plane against a REAL daemon: creates a
// v2 session with a spawnSpec, waits for the daemon's nucleus lane to spawn
// and bind the real agent, sends a prompt, and asserts the agent's real
// answer arrives as durable v2 output events. Exit 0 = pass.
//
//   node v2-live-e2e.mjs --relay http://127.0.0.1:3105 --token <bearer> \
//     --machine v2-live-e2e --agent claude --cwd /tmp/v2-live-<agent> \
//     [--marker pong-claude] [--keep]
import { randomUUID } from 'node:crypto';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const has = (name) => process.argv.includes(`--${name}`);
const RELAY = arg('relay', 'http://127.0.0.1:3105');
const TOKEN = arg('token');
const MACHINE = arg('machine', 'v2-live-e2e');
const AGENT = arg('agent', 'claude');
const CWD = arg('cwd', `/tmp/v2-live-${AGENT}`);
const MARKER = arg('marker', `pong-${AGENT}-${Math.random().toString(36).slice(2, 7)}`);
if (!TOKEN) { console.error('need --token'); process.exit(2); }

const enc = (t) => JSON.stringify({ v: 1, t: 'plain', text: t });
const dec = (ct) => { try { return JSON.parse(ct).text ?? null; } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const step = (okay, name, extra = '') => {
  console.log(`  ${okay ? '✓' : '✗'} [${AGENT}] ${name}${extra ? ' — ' + extra : ''}`);
  if (!okay) failures++;
  return okay;
};

const api = async (method, path, body) => {
  const r = await fetch(`${RELAY}/joy/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const until = async (fn, ms, stepMs = 1000) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(stepMs); }
};

// 1. Spawn a real session on the machine.
const { mkdirSync } = await import('node:fs');
mkdirSync(CWD, { recursive: true });
const created = await api('POST', '/sessions', {
  mode: 'spawn', daemonId: MACHINE, creationIntentId: randomUUID(),
  spawnSpec: JSON.stringify({ v: 1, t: 'spawn', cwd: CWD, agent: AGENT }),
});
if (!step(created.status === 200 && created.json?.sessionId, 'session created (spawn)', `status ${created.status}`)) process.exit(1);
const sid = created.json.sessionId;
console.log(`  · [${AGENT}] v2 session ${sid}`);

// 2. The daemon's lane must claim the spawn, launch the agent, and bind.
const bindDeadline = AGENT === 'claude' ? 90_000 : 120_000;
const boundState = await until(async () => {
  const s = (await api('GET', `/sessions/${sid}`)).json;
  return s && s.sessionState !== 'provisioning' ? s : null;
}, bindDeadline, 2000);
if (!step(!!boundState, `daemon spawned + bound real ${AGENT} session`, boundState ? `state ${boundState.sessionState}` : `no bind in ${bindDeadline / 1000}s`)) process.exit(1);

// 3. Send a marker prompt; the REAL agent must echo the marker back through
// durable v2 output events.
const prompt = `Reply with exactly this text and nothing else: ${MARKER}`;
const m = await api('POST', `/sessions/${sid}/messages`, { ciphertext: enc(prompt), clientIntentId: randomUUID() });
step(m.status === 202, 'prompt accepted 202');

const answered = await until(async () => {
  const ev = (await api('GET', `/sessions/${sid}/events?after=0&limit=500`)).json?.messages ?? [];
  const hit = ev.find((e) => e.kind !== 'turn.queued' && dec(e.content?.ciphertext ?? null)?.includes(MARKER));
  return hit ?? null;
}, 240_000, 3000);
step(!!answered, `real ${AGENT} answered with the marker via v2 output events`, answered ? `event #${answered.seq}` : 'no marker within 240s');

// 4. The turn must terminalize and the message read delivered.
const done = await until(async () => {
  const msg = (await api('GET', `/sessions/${sid}/messages/${m.json.messageId}`)).json;
  const t = (await api('GET', `/sessions/${sid}/turns/${m.json.turnId}`)).json;
  return msg?.status === 'delivered' && t?.state === 'terminal' ? t : null;
}, 120_000, 2000);
step(!!done, 'turn terminal + message delivered', done ? done.terminalState : 'not terminal in 120s');

// 5. Cleanup (unless --keep): purge the v2 session server-side. The local
// agent window is left for the runbook's artifact checks / teardown.
if (!has('keep')) {
  const del = await api('DELETE', `/sessions/${sid}`);
  step(del.status === 200, 'v2 session purged');
}

console.log(failures === 0 ? `PASS ${AGENT}` : `FAIL ${AGENT} (${failures})`);
process.exit(failures === 0 ? 0 : 1);
