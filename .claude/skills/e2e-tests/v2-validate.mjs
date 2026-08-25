// Headless validation of the prod-mirror stack + v2 actor: everything the
// suite's browser tests assert, driven via the same HTTP the app uses.
import { createRequire } from 'node:module';
const tweetnacl = createRequire('/home/claude/Workspace/joy/packages/happy-cli/package.json')('tweetnacl');
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const RELAY = 'http://127.0.0.1:3105';
const ACTOR = '/home/claude/Workspace/joy/.claude/skills/e2e-tests/v2-actor.mjs';
const MACHINE = 'v2-e2e-machine';
const enc = (t) => JSON.stringify({ v: 1, t: 'plain', text: t });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (u8) => Buffer.from(u8).toString('base64');
let pass = 0, fail = 0;
const ok = (cond, name) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ ${name}`); } };

// 1. Mint a throwaway account THROUGH the relay (prod path).
const kp = tweetnacl.sign.keyPair();
const challenge = tweetnacl.randomBytes(32);
const authRes = await fetch(`${RELAY}/v1/auth`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ publicKey: b64(kp.publicKey), challenge: b64(challenge), signature: b64(tweetnacl.sign.detached(challenge, kp.secretKey)) }),
});
const { token } = await authRes.json();
ok(!!token, 'account minted through relay → local happy-server');

const api = async (method, path, body) => {
  const r = await fetch(`${RELAY}/joy/v2${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const until = async (fn, ms = 30000, step = 500) => {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step); }
};

let actor = null;
const startActor = (mode = 'normal') => {
  actor = spawn('node', [ACTOR, '--relay', RELAY, '--token', token, '--machine', MACHINE, '--mode', mode], { stdio: 'inherit' });
};
const stopActor = () => { actor?.kill(); actor = null; };

// 2. Actor up → machine owned → spawn-mode session binds.
startActor();
await sleep(1000);
const created = await api('POST', '/sessions', { mode: 'spawn', daemonId: MACHINE, creationIntentId: randomUUID() });
ok(created.status === 200 && created.json.sessionId, 'v2 session created (spawn) against actor machine');
const sid = created.json.sessionId;
const bound = await until(async () => { const st = (await api('GET', `/sessions/${sid}`)).json?.sessionState; return st && st !== 'provisioning' ? true : null; });
ok(!!bound, 'actor claimed spawn + bound → session active');

// 3. Normal delivery: queued → delivered, echo in the durable log, ephemeral absent.
const m1 = await api('POST', `/sessions/${sid}/messages`, { ciphertext: enc('hello v2'), clientIntentId: randomUUID() });
ok(m1.status === 202, 'message accepted 202');
const delivered = await until(async () => (await api('GET', `/sessions/${sid}/messages/${m1.json.messageId}`)).json?.status === 'delivered' ? true : null);
ok(!!delivered, 'message reached delivered');
const echo = await until(async () => {
  const ev = (await api('GET', `/sessions/${sid}/events?after=0&limit=200`)).json?.messages ?? [];
  return ev.some(e => e.content?.ciphertext?.includes('echo: hello v2')) ? ev : null;
});
ok(!!echo, 'durable echo block in event log');
ok(!(echo ?? []).some(e => e.content?.ciphertext?.includes('thinking')), 'ephemeral deltas NOT persisted');
// Never kill the actor mid-turn: a running turn correctly BLOCKS the lane
// until the sweep orphans it — that is its own test below, not this one.
const turnDone = (turnId) => until(async () => (await api('GET', `/sessions/${sid}/turns/${turnId}`)).json?.state === 'terminal' ? true : null);
await turnDone(m1.json.turnId);

// 4. Offline queueing: kill actor, send, stays queued; restart, delivers.
stopActor(); await sleep(500);
const m2 = await api('POST', `/sessions/${sid}/messages`, { ciphertext: enc('while offline'), clientIntentId: randomUUID() });
await sleep(2500);
ok((await api('GET', `/sessions/${sid}/messages/${m2.json.messageId}`)).json.status === 'queued', 'stays queued while machine offline');
startActor();
ok(!!(await until(async () => (await api('GET', `/sessions/${sid}/messages/${m2.json.messageId}`)).json?.status === 'delivered' ? true : null)), 'delivered after actor returns');
await turnDone(m2.json.turnId);

// 5. Orphan + retry, THE PROD WAY: die-after-start, real 20s lease TTL, real sweep.
stopActor(); await sleep(500);
startActor('die-after-start');
const m3 = await api('POST', `/sessions/${sid}/messages`, { ciphertext: enc('doomed'), clientIntentId: randomUUID() });
const orphaned = await until(async () => {
  const s = (await api('GET', `/sessions/${sid}/messages/${m3.json.messageId}`)).json;
  return s?.status === 'failed' && s.failure?.mayHaveDelivered ? true : null;
}, 60000, 2000);
ok(!!orphaned, 'lease expiry + sweep → failed with mayHaveDelivered (took real TTL)');
startActor();
const retried = await api('POST', `/sessions/${sid}/messages/${m3.json.messageId}/retry`);
ok(retried.status === 202, 'retry accepted');
ok(!!(await until(async () => (await api('GET', `/sessions/${sid}/messages/${m3.json.messageId}`)).json?.status === 'delivered' ? true : null)), 'retried message delivered by fresh lease');
await turnDone(m3.json.turnId);

// 6. Cancellation via the control lane (slow mode).
stopActor(); await sleep(500);
startActor('slow');
const m4 = await api('POST', `/sessions/${sid}/messages`, { ciphertext: enc('long one'), clientIntentId: randomUUID() });
await until(async () => (await api('GET', `/sessions/${sid}`)).json?.execution?.turnId === m4.json.turnId ? true : null);
const cxl = await api('POST', `/sessions/${sid}/turns/${m4.json.turnId}/cancellations`, { clientIntentId: randomUUID() });
ok(cxl.json?.disposition === 'cancellation_requested', 'cancellation accepted for running turn');
const cancelled = await until(async () => {
  const t = (await api('GET', `/sessions/${sid}/turns/${m4.json.turnId}`)).json;
  return t?.state === 'terminal' && t.terminalState === 'cancelled' ? true : null;
}, 30000);
ok(!!cancelled, 'actor honoured cancel via control lane → terminal(cancelled)');
stopActor(); startActor();

// 7. Attachments: upload, cite, fetch, dedupe.
const bytes = Buffer.from(enc('attachment payload'));
const up = await fetch(`${RELAY}/joy/v2/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Session': sid }, body: bytes });
const att = await up.json();
ok(up.status === 201 && att.attachmentId, 'attachment uploaded 201');
const up2 = await fetch(`${RELAY}/joy/v2/attachments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'X-Session': sid }, body: bytes });
ok(up2.status === 200 && (await up2.json()).attachmentId === att.attachmentId, 'identical re-upload deduped to same id');
const m5 = await api('POST', `/sessions/${sid}/messages`, { ciphertext: enc('with file'), clientIntentId: randomUUID(), attachments: [att.attachmentId] });
ok(m5.status === 202, 'message citing attachment accepted');
// The REFERENCE must reach the machine plane: the actor fetches the bytes and
// folds a marker into its durable echo.
const attEcho = await until(async () => {
  const ev = (await api('GET', `/sessions/${sid}/events?after=0&limit=200`)).json?.messages ?? [];
  return ev.some(e => e.content?.ciphertext?.includes(`[att:1/${bytes.length}b]`)) ? true : null;
});
ok(!!attEcho, 'attachment reference delivered to the daemon (actor fetched the bytes)');
const got = await fetch(`${RELAY}/joy/v2/attachments/${att.attachmentId}`, { headers: { Authorization: `Bearer ${token}` } });
ok((await got.text()) === bytes.toString() && got.headers.get('cache-control')?.includes('immutable'), 'attachment bytes + immutable caching');

// 8. Purge cascades.
await until(async () => (await api('GET', `/sessions/${sid}/messages/${m5.json.messageId}`)).json?.status === 'delivered' ? true : null);
stopActor();
const del = await api('DELETE', `/sessions/${sid}`);
ok(del.status === 200, 'session purged');
ok((await fetch(`${RELAY}/joy/v2/attachments/${att.attachmentId}`, { headers: { Authorization: `Bearer ${token}` } })).status === 404, 'purge cascaded the attachment');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
