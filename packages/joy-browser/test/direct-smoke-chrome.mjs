#!/usr/bin/env node
// Direct mode in a REAL Chromium — by hand, like chrome-smoke.mjs:
//
//   node test/direct-smoke-chrome.mjs [/path/to/chrome]
//
// The extension pairs, picks the direct machine with Connection = Direct, and
// from then on reaches that machine's daemon over a WebRTC data channel (the
// offscreen document holds the peer). The relay is real and carries only the
// sealed offer and answer; the test proves it never holds a session.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { EXT, until, step, cleanup, run, startWorld, startDirectDaemon, DIRECT_MACHINE } from './smoke-lib.mjs';
import { cdp } from './cdp.mjs';

const CHROME = process.argv[2] ?? [join(homedir(), '.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'), '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!CHROME) { console.error('no Chromium found — pass its path as the first argument'); process.exit(2); }

async function main() {
  const w = await startWorld();
  const d = await startDirectDaemon(w);

  const profile = mkdtempSync(join(tmpdir(), 'joy-browser-direct-chrome-'));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.DISPLAY;
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1100,800', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  cleanup.push(() => chrome.kill('SIGKILL'));
  let chromeErr = ''; chrome.stderr.on('data', (x) => (chromeErr += x));
  const wsUrl = await until('Chromium DevTools', () => /DevTools listening on (ws:\/\/\S+)/.exec(chromeErr)?.[1]);
  const http = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const targets = () => fetch(`${http}/json/list`).then((r) => r.json());
  const open = async (url) => cdp((await fetch(`${http}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json())).webSocketDebuggerUrl);
  const worker = await until('the extension service worker', async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js')));
  const extId = new URL(worker.url).host;
  step(`extension loaded (${extId})`);

  // ── pair, then the direct machine with Connection = Direct ──
  const popup = await open(`chrome-extension://${extId}/popup.html`);
  const popupText = () => popup.evaluate('document.body.innerText');
  const press = (label) => popup.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes(${JSON.stringify(label)})); if (!b) throw new Error('no button: ' + ${JSON.stringify(label)} + ' in: ' + document.body.innerText); b.click(); })()`);
  await until('the pairing form', () => popup.evaluate(`!!document.querySelector('input[type=password]')`));
  await popup.evaluate(`(() => { const [relay, code] = document.querySelectorAll('input'); relay.value = ${JSON.stringify(w.relayUrl)}; code.value = ${JSON.stringify(w.backupCode)}; })()`);
  await press('Continue');
  await until('the direct machine, online', () => popup.evaluate(`[...document.querySelectorAll('option')].some((o) => o.textContent === 'direct-box' && !o.disabled)`)).catch(async (e) => { throw new Error(`${e.message} — popup shows: ${await popupText()}\n${d.log()}`); });
  await popup.evaluate(`(() => { const [machine, mode] = document.querySelectorAll('select'); machine.value = ${JSON.stringify(DIRECT_MACHINE)}; mode.value = 'direct'; mode.dispatchEvent(new Event('change')); })()`);
  if (!/never pass through it/.test(await popupText())) throw new Error('the Direct explanation is not shown');
  await press('Start my session');

  const hello = await d.takePrompt('the browser hello, over the data channel').catch(async (e) => { throw new Error(`${e.message} — popup: ${await popupText()}\n${d.log()}\ndiagnostics: ${JSON.stringify(await popup.evaluate(`chrome.runtime.sendMessage({ type: 'diagnostics' })`))}`); });
  if (!/^<joy-message from="browser">\nA browser is now attached/.test(hello.text)) throw new Error(`unexpected hello: ${hello.text}`);
  const { specs } = await d.state();
  if (specs[0]?.localOnly !== true || specs[0]?.headless !== true || specs[0]?.cwd !== '~/joy-browser') throw new Error(`unexpected spawn: ${JSON.stringify(specs[0])}`);
  step('Direct: the session was created local-only on the daemon, and the hello arrived peer to peer');

  // ── a script, run in a real page, answered over the channel ──
  const answer = await d.agentTurn(hello.id, `Reading it.\n\n<joy-browser-execute url="${w.pageUrl}">\nreturn { title: document.title, price: document.querySelector(".price").textContent };\n</joy-browser-execute>`, 'the script result');
  if (!/status: ok/.test(answer.text) || !/"price": "\$49 \/ month"/.test(answer.text)) throw new Error(`unexpected result:\n${answer.text}`);
  await d.say(hello.id, 'Done.', true);
  step('the agent\'s script ran in the page; its result went back to the daemon');

  // ── the page button: type, and the reply renders ──
  const page = await open(w.pageUrl);
  await page.send('Page.bringToFront');
  const fab = await until('the page button', () => page.inWidget((n, attr) => attr(n, 'class')?.split(' ').includes('fab')));
  await page.click(fab);
  await until('the chat panel', () => page.inWidget((n, attr) => attr(n, 'class') === 'panel open'));
  await until('the textarea to take focus', async () => { const t = await page.inWidget((n) => n.nodeName === 'TEXTAREA'); return t && page.call(t, 'function () { return this.getRootNode().activeElement === this; }'); });
  await page.type('What does the Pro plan cost?');
  const asked = await d.takePrompt('the chat message');
  if (asked.text !== 'What does the Pro plan cost?') throw new Error(`the chat message arrived as ${JSON.stringify(asked.text)}`);
  await d.say(asked.id, 'It is **$49** a month.', true);
  const panelText = async () => { const p = await page.inWidget((n, attr) => attr(n, 'class')?.startsWith('panel')); return p ? page.call(p, 'function () { return this.textContent; }') : ''; };
  await until('the reply in the panel', async () => { const t = await panelText(); return t.includes('What does the Pro plan cost?') && t.includes('$49') && !t.includes('**') && !t.includes('working…'); }).catch(async (e) => { throw new Error(`${e.message} — panel shows: ${await panelText()}`); });
  step('page button → panel: the message reached the daemon; the reply and the history rendered');

  // ── the relay never held a session ──
  const { sessions = [] } = await w.api('GET', '/sessions');
  if (sessions.length) throw new Error(`the relay holds ${sessions.length} session(s): ${JSON.stringify(sessions)}`);
  if (!(await popupText()).includes('direct')) throw new Error('the popup does not say the session is direct');
  step('the relay lists no session for the account: nothing but the setup went through it');

  // ── the worker stops: the peer goes with it, and comes back ──
  await popup.send('ServiceWorker.enable');
  await popup.send('ServiceWorker.stopAllWorkers');
  const resumed = await until('the restarted worker', () => popup.evaluate(`chrome.runtime.sendMessage({ type: 'status' })`).catch(() => null));
  if (!resumed.linked?.direct) throw new Error('the restart lost the direct link');
  // A fresh page: the panel's old port died with the worker (it finds that
  // out by itself within 45 s; this test does not wait for it).
  await page.send('Page.reload');
  const again = await until('the page button after reload', () => page.inWidget((n, attr) => attr(n, 'class')?.split(' ').includes('fab')));
  await page.click(again);
  await until('the textarea to take focus again', async () => { const t = await page.inWidget((n) => n.nodeName === 'TEXTAREA'); return t && page.call(t, 'function () { return this.getRootNode().activeElement === this; }'); });
  await page.type('Still there?');
  const after = await d.takePrompt('the message after the restart').catch(async (e) => { throw new Error(`${e.message} — panel: ${await panelText()}\ndiagnostics: ${JSON.stringify(await popup.evaluate(`chrome.runtime.sendMessage({ type: 'diagnostics' })`), null, 1)}\n${d.log().slice(-2000)}`); });
  await d.say(after.id, 'Yes, still here.', true);
  await until('the reply after the restart', async () => (await panelText()).includes('Yes, still here.')).catch(async (e) => { throw new Error(`${e.message} — panel shows: ${await panelText()}`); });
  step('worker stopped: a new peer connected by itself; chat still works');
}

await run('joy-browser Direct smoke test — Chromium', main);
