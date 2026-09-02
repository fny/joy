#!/usr/bin/env node
// One-harness live e2e over the v2 plane against a REAL daemon: creates a
// v2 session with a spawnSpec, waits for the daemon's nucleus lane to spawn
// and bind the real agent, sends a prompt, and asserts the agent's real
// answer arrives as durable v2 output events. Exit 0 = pass.
//
//   node v2-live-e2e.mjs --relay http://127.0.0.1:3105 --token <bearer> \
//     --machine v2-live-e2e --agent claude --cwd /tmp/v2-live-<agent> \
//     --home ~/.joy-test [--marker pong-claude] [--attach] [--purge]
//
// --attach: instead of a plain marker prompt, upload a sealed text file whose
// body is the marker and ask the agent to read the attached file — proving
// the daemon fetched, opened and materialized the attachment into the cwd.
//
// --home is the daemon's JOY_HOME_DIR from mint-daemon-creds.mjs: the account
// content secret it wrote there opens the per-session key envelope, so the
// driver reads the daemon's SEALED output the way the app does (and seals its
// own prompt the same way). Without it only plaintext sessions can be read.
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const REPO = process.env.JOY_REPO ?? new URL('../../..', import.meta.url).pathname;
const nacl = createRequire(`${REPO}/packages/joy-daemon/package.json`)('tweetnacl');

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
const HOME = arg('home', `${process.env.HOME}/.joy-test`).replace(/^~/, process.env.HOME ?? '');
const MARKER = arg('marker', `pong-${AGENT}-${Math.random().toString(36).slice(2, 7)}`);
if (!TOKEN) { console.error('need --token'); process.exit(2); }

// Account content secret (same relay-dir layout mint-daemon-creds.mjs writes).
const u = new URL(RELAY);
const secretFile = join(HOME, 'relays', u.port ? `${u.hostname}_${u.port}` : u.hostname, 'e2e-content.secret');
const contentSecret = existsSync(secretFile) ? new Uint8Array(Buffer.from(readFileSync(secretFile, 'utf8').trim(), 'base64')) : null;

// Wire formats mirror joy-daemon src/relay/nucleusLane.ts:
//   envelope "v2sk1:" + b64(epk32 ‖ nonce24 ‖ box(sessionKey))
//   content  "v2e1:"  + b64(nonce24 ‖ secretbox(utf8(json)))
let sessionKey = null;
const openEnvelope = (envelope) => {
  if (!envelope?.startsWith('v2sk1:') || !contentSecret) return null;
  const raw = Buffer.from(envelope.slice(6), 'base64');
  const key = nacl.box.open(new Uint8Array(raw.subarray(56)), new Uint8Array(raw.subarray(32, 56)), new Uint8Array(raw.subarray(0, 32)), contentSecret);
  return key ?? null;
};
const enc = (t, attachments) => {
  const json = JSON.stringify({ v: 1, t: 'plain', text: t, ...(attachments?.length ? { attachments } : {}) });
  if (!sessionKey) return json;
  const nonce = new Uint8Array(randomBytes(nacl.secretbox.nonceLength));
  const ct = nacl.secretbox(new Uint8Array(Buffer.from(json, 'utf8')), nonce, sessionKey);
  return 'v2e1:' + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString('base64');
};
const dec = (ct) => {
  if (!ct) return null;
  if (ct.startsWith('v2e1:')) {
    if (!sessionKey) return null;
    const raw = Buffer.from(ct.slice(5), 'base64');
    const n = nacl.secretbox.nonceLength;
    const pt = nacl.secretbox.open(new Uint8Array(raw.subarray(n)), new Uint8Array(raw.subarray(0, n)), sessionKey);
    if (!pt) return null;
    try { return textOf(JSON.parse(Buffer.from(pt).toString('utf8'))); } catch { return null; }
  }
  try { return textOf(JSON.parse(ct)); } catch { return null; }
};
// Text of a payload: a plain message, or a forwarded adapter record whose
// session envelope is a text event (tool calls / lifecycle records → null).
const textOf = (p) => {
  if (!p) return null;
  if (p.t === 'record') {
    const ev = p.record?.content?.data?.ev;
    return ev?.t === 'text' && typeof ev.text === 'string' ? ev.text : null;
  }
  return typeof p.text === 'string' ? p.text : null;
};
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

// 2b. The bind carried the session-key envelope; open it with the account
// content secret so sealed content is readable (the app's exact path).
const listed = ((await api('GET', '/sessions')).json?.sessions ?? []).find((s) => s.sessionId === sid);
const envelope = listed?.sessionKeyEnvelope ?? null;
if (envelope && envelope !== 'v2:plaintext') {
  sessionKey = openEnvelope(envelope);
  if (!step(!!sessionKey, 'opened the session-key envelope with the account content secret', sessionKey ? 'sealed session' : `cannot open ${envelope.slice(0, 6)}… (secret ${contentSecret ? 'present' : `missing: ${secretFile}`})`)) process.exit(1);
} else {
  console.log(`  · [${AGENT}] plaintext session (envelope ${envelope ?? 'none'})`);
}

// 3. Send a marker prompt; the REAL agent must echo the marker back through
// durable v2 output events. With --attach the marker travels ONLY inside a
// sealed attachment (app sealV2Bytes layout: nonce24 ‖ secretbox(bytes)).
let prompt = `Reply with exactly this text and nothing else: ${MARKER}`;
let attachments = [];
if (has('attach')) {
  const { createHash } = await import('node:crypto');
  const name = `secret-${Math.random().toString(36).slice(2, 7)}.txt`;
  const plain = new Uint8Array(Buffer.from(`${MARKER}\n`, 'utf8'));
  let body = plain;
  if (sessionKey) {
    const nonce = new Uint8Array(randomBytes(nacl.secretbox.nonceLength));
    body = new Uint8Array(Buffer.concat([Buffer.from(nonce), Buffer.from(nacl.secretbox(plain, nonce, sessionKey))]));
  }
  const up = await fetch(`${RELAY}/joy/v2/attachments`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/octet-stream', 'x-session': sid, 'x-cipher-hash': createHash('sha256').update(body).digest('hex') },
    body,
  });
  const upJson = await up.json().catch(() => null);
  if (!step(up.status === 201 && upJson?.attachmentId, 'sealed attachment uploaded', `status ${up.status}`)) process.exit(1);
  attachments = [{ id: upJson.attachmentId, name, size: plain.length, mime: 'text/plain' }];
  prompt = `A text file is attached below (its path is on the last line, relative to your cwd). Read it and reply with exactly its contents, trimmed, and nothing else.`;
}
const m = await api('POST', `/sessions/${sid}/messages`, { ciphertext: enc(prompt, attachments), clientIntentId: randomUUID(), ...(attachments.length ? { attachments: attachments.map((a) => a.id) } : {}) });
if (!step(m.status === 202, 'prompt accepted 202', `status ${m.status}`)) { console.log(`FAIL ${AGENT} (send rejected)`); process.exit(1); }

const answered = await until(async () => {
  const ev = (await api('GET', `/sessions/${sid}/events?after=0&limit=500`)).json?.messages ?? [];
  const hit = ev.find((e) => e.kind !== 'turn.queued' && dec(e.content?.ciphertext ?? null)?.includes(MARKER));
  return hit ?? null;
}, 240_000, 3000);
step(!!answered, `real ${AGENT} answered with the marker via v2 output events${attachments.length ? ' (read from the attachment)' : ''}`, answered ? `event #${answered.seq}` : 'no marker within 240s');

// The daemon must have materialized the file into the cwd under the name
// the sealed citation carried (non-images keep their sanitized name).
if (attachments.length) {
  const onDisk = existsSync(join(CWD, attachments[0].name)) && readFileSync(join(CWD, attachments[0].name), 'utf8').includes(MARKER);
  step(onDisk, 'attachment materialized in the session cwd with its plaintext contents', `${CWD}/${attachments[0].name}`);
}

// Exactly-once: after the turn settles, the marker must appear in EXACTLY
// one non-queued event (a find() would pass duplicates silently).
if (answered) {
  const evAll = (await api('GET', `/sessions/${sid}/events?after=0&limit=500`)).json?.messages ?? [];
  const hits = evAll.filter((e) => e.kind !== 'turn.queued' && dec(e.content?.ciphertext ?? null)?.includes(MARKER));
  step(hits.length === 1, 'marker appears exactly once in the durable log', `count ${hits.length}`);
}

// 4. The turn must terminalize and the message read delivered.
const done = await until(async () => {
  const msg = (await api('GET', `/sessions/${sid}/messages/${m.json.messageId}`)).json;
  const t = (await api('GET', `/sessions/${sid}/turns/${m.json.turnId}`)).json;
  return msg?.status === 'delivered' && t?.state === 'terminal' ? t : null;
}, 120_000, 2000);
step(!!done, 'turn terminal + message delivered', done ? done.terminalState : 'not terminal in 120s');

// 5. Evidence is KEPT by default (the runbook cross-checks artifacts after
// each run and purges in teardown). --purge removes the session now.
if (has('purge')) {
  const del = await api('DELETE', `/sessions/${sid}`);
  step(del.status === 200, 'v2 session purged');
} else {
  console.log(`  · [${AGENT}] session kept for artifact checks: ${sid}`);
}

console.log(failures === 0 ? `PASS ${AGENT}` : `FAIL ${AGENT} (${failures})`);
process.exit(failures === 0 ? 0 : 1);
