// What both real-browser smoke tests share: a page worth scripting, the REAL
// relay (real accounts and tokens, PGlite in a temp dir), and the daemon's part
// played by hand — a machine with a sealed card, a lease, and the verbs a
// daemon uses to bind a spawn, take a prompt, speak and end a turn.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import * as N from '../../joy-mcp/src/crypto.mjs';
import { loginWithSecret } from '../../joy-mcp/src/relay.mjs';

const here = dirname(fileURLToPath(import.meta.url));
export const EXT = join(here, '..');
export const MACHINE = 'smoke-machine';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (what, fn, ms = 30_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(150); } };
export const step = (s) => console.log(`  · ${s}`);
export const cleanup = [];

/** Run `main`, print PASS/FAIL, undo everything, exit. */
export async function run(name, main) {
  let code = 0;
  try { console.log(name); await main(); console.log('PASS'); }
  catch (e) { console.error(`\nFAIL: ${e.stack ?? e}`); code = 1; }
  finally { for (const c of cleanup.reverse()) { try { await c(); } catch { /* best effort */ } } }
  process.exit(code);
}

export async function startWorld() {
  // ── a page worth scripting ──
  const site = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Pricing</title><h1>Plans</h1><p class="price">$49 / month</p><script>console.log("page ready")</script>'); });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  cleanup.push(() => site.close());
  const pageUrl = `http://127.0.0.1:${site.address().port}/pricing`;

  // ── the real relay ──
  const dataDir = mkdtempSync(join(tmpdir(), 'joy-browser-smoke-relay-'));
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const relayProc = spawn(process.execPath, [join(here, '../../joy-relay/server.mjs')], { env: { ...process.env, JOY_RELAY_PORT: String(port), JOY_RELAY_DATA_DIR: dataDir, JOY_RELAY_DOCS: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => relayProc.kill('SIGTERM'));
  let relayLog = ''; relayProc.stdout.on('data', (d) => (relayLog += d)); relayProc.stderr.on('data', (d) => (relayLog += d));
  const relayUrl = `http://localhost:${port}`; // NOT 127.0.0.1: that host gets excluded by the test
  await until('the relay to listen', async () => fetch(`${relayUrl}/joy/v2/capabilities`).then((r) => r.ok, () => false)).catch((e) => { throw new Error(`${e.message}\n${relayLog}`); });
  step(`relay up at ${relayUrl}`);

  // ── an account, and a machine with a daemon (played by hand) on it ──
  const accountSecret = new Uint8Array(randomBytes(32));
  const backupCode = Buffer.from(accountSecret).toString('base64url');
  const contentPub = N.contentKeyPair(accountSecret).publicKey;
  const { token } = await loginWithSecret(relayUrl, accountSecret);
  const api = async (method, path, body, headers = {}) => {
    const r = await fetch(`${relayUrl}/joy/v2${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`);
    return j;
  };
  const machineKey = new Uint8Array(randomBytes(32));
  await api('POST', '/machines', { id: MACHINE, metadata: N.sealMachineMetadata({ host: 'smoke', displayName: 'smoke-box', capabilities: { spawnSpecSealed: true } }, machineKey), dataEncryptionKey: N.sealMachineKey(machineKey, contentPub) });
  const lease = await api('POST', '/daemon/leases', { machineId: MACHINE });
  const L = { 'x-joy-lease-id': lease.leaseId, 'x-joy-lease-token': lease.leaseToken, 'x-joy-lease-epoch': String(lease.epoch) };
  const renew = setInterval(() => void api('PUT', `/daemon/leases/${lease.leaseId}`, {}, L).catch(() => {}), 5_000);
  cleanup.push(() => clearInterval(renew));
  const claim = async () => (await api('POST', `/daemon/leases/${lease.leaseId}/claims/work`, { noWait: true }, L)).offers ?? [];
  const sessionKey = new Uint8Array(randomBytes(32));
  let sessionId = null;
  step('machine smoke-box registered, its daemon holds the lease');

  const takePrompt = async (what) => {
    const offer = await until(what, async () => (await claim()).find((o) => o.sessionId === sessionId && o.kind === 'prompt'));
    await api('POST', `/daemon/deliveries/${offer.deliveryId}/received`, undefined, L);
    await api('POST', `/daemon/turns/${offer.turnId}/submitted`, undefined, L);
    await api('POST', `/daemon/turns/${offer.turnId}/start`, { runtimeEventId: randomUUID() }, L);
    return { turnId: offer.turnId, text: N.openPayload(offer.ciphertext ?? offer.content?.ciphertext, sessionKey)?.text };
  };
  const say = (turnId, text) => api('POST', `/daemon/turns/${turnId}/facts`, { type: 'output', runtimeEventId: randomUUID(), ciphertext: N.sealV2Json({ v: 1, t: 'record', record: { role: 'session', content: { type: 'session', data: { id: randomUUID(), time: Date.now(), role: 'agent', turn: turnId, ev: { t: 'text', text } } }, meta: { sentFrom: 'joy' } } }, sessionKey) }, L);
  const endTurn = (turnId) => api('POST', `/daemon/turns/${turnId}/facts`, { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() }, L);
  /** One agent turn: say this, end the turn, and hand back the browser's answer. */
  const agentTurn = async (turnId, text, what) => { await say(turnId, text); await endTurn(turnId); return takePrompt(what); };
  /** The daemon's half of the spawn the extension asks for: open the sealed spec, bind. */
  const acceptSpawn = async () => {
    const offer = await until('the spawn offer', async () => (await claim()).find((o) => o.kind === 'spawn_session'));
    const spec = N.openV2Json(offer.ciphertext, N.deriveKey(machineKey, 'Joy Spawn Spec', [MACHINE]));
    if (!spec || spec.cwd !== '~/joy-browser' || spec.agent !== 'claude' || spec.headless !== true || spec.createDir !== true) throw new Error(`unexpected spawn spec: ${JSON.stringify(spec)}`);
    sessionId = offer.sessionId;
    await api('POST', `/daemon/deliveries/${offer.deliveryId}/received`, undefined, L);
    await api('POST', `/daemon/sessions/${sessionId}/bind`, { spawnCommandId: offer.commandId, localSessionId: 'c0ffee42', sessionKeyEnvelope: N.sealSessionKeyEnvelope(sessionKey, contentPub) }, L);
    await api('PATCH', `/daemon/sessions/${sessionId}`, { encryptedMetadata: N.sealCard({ path: '/home/smoke/joy-browser', host: 'smoke', summary: { text: 'Browser session' }, joy__headless: true }, sessionKey) }, L);
    step(`spawn spec arrived sealed for this machine (headless claude in ${spec.cwd}); bound as c0ffee42`);
  };
  /** A message from another client of the account (the app, say). */
  const sendAsAccount = (text) => api('POST', `/sessions/${sessionId}/messages`, { ciphertext: N.sealText(text, sessionKey), clientIntentId: randomUUID() });

  return { pageUrl, relayUrl, backupCode, token, contentPub, api, takePrompt, say, endTurn, agentTurn, acceptSpawn, sendAsAccount };
}

/** The agent's first exchange, identical in both browsers: the hello, a script
 *  that opens and reads a page, and a script that throws. Returns the open turn. */
export async function helloAndScripts(w) {
  const hello = await w.takePrompt('the browser hello');
  if (!/^<joy-message from="browser">\nA browser is now attached/.test(hello.text ?? '')) throw new Error(`unexpected hello: ${hello.text}`);
  step('linked: hello received as <joy-message from="browser">');
  const answer = await w.agentTurn(hello.turnId, `Reading the pricing page.\n\n<joy-browser-execute url="${w.pageUrl}">\nconsole.log("counting", document.querySelectorAll("p").length);\nawait new Promise((r) => setTimeout(r, 50));\nreturn { title: document.title, price: document.querySelector(".price").textContent, cheap: 1 < 2 && 3 > 2 };\n</joy-browser-execute>`, 'the script result');
  console.log('\n' + answer.text.split('\n').map((l) => `    ${l}`).join('\n') + '\n');
  for (const re of [/^<joy-message from="browser">/, /status: ok/, /"title": "Pricing"/, /"price": "\$49 \/ month"/, /"cheap": true/, /log: counting 1/, new RegExp(w.pageUrl.replace(/[/.]/g, '\\$&')), /<\/joy-message>$/]) if (!re.test(answer.text)) throw new Error(`the result is missing ${re}`);
  const failure = await w.agentTurn(answer.turnId, '<joy-browser-execute>\nreturn nope.nothing;\n</joy-browser-execute>', 'the error result');
  if (!/status: error\nerror: ReferenceError: nope is not defined/.test(failure.text)) throw new Error(`expected a ReferenceError, got:\n${failure.text}`);
  step('scripts run in a real page; a throwing one comes back as status: error');
  await w.say(failure.turnId, 'Noted.'); await w.endTurn(failure.turnId);
  return answer;
}

/** Direct mode's machine: a second machine on the account whose daemon is the
 *  stand-in (direct-daemon.ts) — the REAL tunnel executor and WebRTC
 *  transport, with an agent the test plays. Nothing is relay-side but the
 *  machine record and its lease. */
export const DIRECT_MACHINE = 'direct-machine';
export async function startDirectDaemon(w) {
  const machineKey = new Uint8Array(randomBytes(32));
  await w.api('POST', '/machines', { id: DIRECT_MACHINE, metadata: N.sealMachineMetadata({ host: 'direct', displayName: 'direct-box', capabilities: { spawnSpecSealed: true } }, machineKey), dataEncryptionKey: N.sealMachineKey(machineKey, w.contentPub) });
  const tsx = [join(here, '../../joy-daemon/node_modules/.bin/tsx'), join(here, '../../../node_modules/.bin/tsx')].find(existsSync); // hoisted or not
  if (!tsx) throw new Error('tsx not found — run pnpm install at the repo root');
  const proc = spawn(tsx, [join(here, 'direct-daemon.ts')], { env: { ...process.env, RELAY_URL: w.relayUrl, TOKEN: w.token, MACHINE_ID: DIRECT_MACHINE, MACHINE_KEY: Buffer.from(machineKey).toString('base64') }, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => proc.kill('SIGTERM'));
  let out = ''; let err = '';
  proc.stdout.on('data', (d) => (out += d)); proc.stderr.on('data', (d) => (err += d));
  const port = await until('the direct daemon', () => /listening (\d+)/.exec(out)?.[1]).catch((e) => { throw new Error(`${e.message}\n${err}`); });
  const ctl = async (path, body) => (await fetch(`http://127.0.0.1:${port}/_test/${path}`, { method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined })).json();
  let seen = 0;
  /** The next prompt that reaches the agent, in order. */
  const takePrompt = async (what) => until(what, async () => { const { prompts } = await ctl('prompts'); if (prompts.length > seen) return prompts[seen++]; return null; });
  const say = (id, text, end = false) => ctl('say', { id, text, end });
  const agentTurn = async (id, text, what) => { await say(id, text, true); return takePrompt(what); };
  step('machine direct-box registered; its stand-in daemon runs the real tunnel executor and WebRTC transport');
  return { takePrompt, say, agentTurn, state: () => ctl('prompts'), log: () => err };
}
