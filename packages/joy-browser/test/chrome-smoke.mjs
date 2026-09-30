#!/usr/bin/env node
// A REAL-BROWSER smoke test — not part of `pnpm test`, because it needs a
// Chromium binary and starts a relay. Run it by hand:
//
//   node test/chrome-smoke.mjs [/path/to/chrome]
//   JOY_SMOKE_SHOT=/tmp/panel.png node test/chrome-smoke.mjs   (also saves a picture of the chat panel)
//
// Against the real relay and a hand-played daemon (smoke-lib.mjs), it loads
// this directory unpacked in headless Chromium and does what a person would,
// with real mouse and keyboard input: pairs in the popup, picks a machine,
// lets the extension start its own headless session, talks to it through the
// page button, approves a script the agent asked to keep, and excludes a site.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { EXT, sleep, until, step, cleanup, run, startWorld, helloAndScripts } from './smoke-lib.mjs';
import { cdp } from './cdp.mjs';

const CHROME = process.argv[2] ?? [join(homedir(), '.cache/ms-playwright/chromium-1208/chrome-linux64/chrome'), '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
if (!CHROME) { console.error('no Chromium found — pass its path as the first argument'); process.exit(2); }

async function main() {
  const w = await startWorld();
  const { pageUrl, relayUrl, backupCode, takePrompt, say, endTurn, agentTurn } = w;

  // ── Chromium, with this directory loaded unpacked ──
  const profile = mkdtempSync(join(tmpdir(), 'joy-browser-smoke-chrome-'));
  cleanup.push(() => rmSync(profile, { recursive: true, force: true }));
  const env = { ...process.env }; delete env.DISPLAY;
  const chrome = spawn(CHROME, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--window-size=1100,800', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, 'about:blank'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  cleanup.push(() => chrome.kill('SIGKILL'));
  let chromeErr = ''; chrome.stderr.on('data', (d) => (chromeErr += d));
  const wsUrl = await until('Chromium DevTools', () => /DevTools listening on (ws:\/\/\S+)/.exec(chromeErr)?.[1]);
  const http = wsUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/.*$/, '');
  const targets = () => fetch(`${http}/json/list`).then((r) => r.json());
  const open = async (url) => cdp((await fetch(`${http}/json/new?${url}`, { method: 'PUT' }).then((r) => r.json())).webSocketDebuggerUrl);
  const worker = await until('the extension service worker', async () => (await targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'))).catch((e) => { throw new Error(`${e.message}\n${chromeErr.slice(-1500)}`); });
  const extId = new URL(worker.url).host;
  step(`extension loaded (${extId}), service worker running`);

  // ── setup in the popup: relay + code, then the machine ──
  const popup = await open(`chrome-extension://${extId}/popup.html`);
  const popupText = () => popup.evaluate('document.body.innerText');
  const press = (label) => popup.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes(${JSON.stringify(label)})); if (!b) throw new Error('no button: ' + ${JSON.stringify(label)} + ' in: ' + document.body.innerText); b.click(); })()`);
  await until('the pairing form', () => popup.evaluate(`!!document.querySelector('input[type=password]')`));
  await popup.evaluate(`(() => { const [relay, code] = document.querySelectorAll('input'); relay.value = ${JSON.stringify(relayUrl)}; code.value = ${JSON.stringify(backupCode)}; })()`);
  await press('Continue');
  await until('the machine step', () => popup.evaluate(`[...document.querySelectorAll('option')].some((o) => o.textContent === 'smoke-box' && !o.disabled)`)).catch(async (e) => { throw new Error(`${e.message} — popup shows: ${await popupText()}`); });
  step('paired from the backup code; the machine is offered by its sealed name, online');
  await press('Start my session');

  await w.acceptSpawn();
  await helloAndScripts(w);
  await until('the popup to show the linked session', async () => (await popupText()).includes('c0ffee42'));

  // ── the page button: a real click, real typing, and the reply in the panel ──
  const page = await open(pageUrl);
  await page.send('Page.bringToFront');
  const fab = await until('the page button', () => page.inWidget((n, attr) => attr(n, 'class')?.split(' ').includes('fab')));
  if (await page.evaluate(`document.querySelector('joy-browser-root').shadowRoot`) !== null) throw new Error('the page can see into the widget');
  await page.click(fab);
  await until('the chat panel to open', () => page.inWidget((n, attr) => attr(n, 'class') === 'panel open'));
  await until('the textarea to take focus', async () => { const t = await page.inWidget((n) => n.nodeName === 'TEXTAREA'); return t && page.call(t, 'function () { return this.getRootNode().activeElement === this; }'); });
  await page.type('What does the Pro plan cost?');
  const asked = await takePrompt('the chat message');
  if (asked.text !== 'What does the Pro plan cost?') throw new Error(`the chat message arrived as: ${JSON.stringify(asked.text)}`);
  await say(asked.turnId, 'It is **$49** a month.\n\n<joy-title value="Pricing" />'); await endTurn(asked.turnId);
  const panelText = async () => { const p = await page.inWidget((n, attr) => attr(n, 'class')?.startsWith('panel')); return p ? page.call(p, 'function () { return this.textContent; }') : ''; };
  await until('the reply in the panel', async () => { const t = await panelText(); return t.includes('What does the Pro plan cost?') && t.includes('$49') && !t.includes('joy-title') && !t.includes('**') && !t.includes('working…') && !t.includes('the browser answered✓'); }).catch(async (e) => { throw new Error(`${e.message} — panel shows: ${await panelText()}`); });
  if (process.env.JOY_SMOKE_SHOT) { writeFileSync(process.env.JOY_SMOKE_SHOT, Buffer.from((await page.send('Page.captureScreenshot', { format: 'png' })).data, 'base64')); }
  step('page button → panel: typed a message, it reached the session as the user; the reply rendered, control tags hidden');

  // ── a remembered script: saved OFF, runs only after the user approves it ──
  await page.type('Always show that price as FREE.');
  const keep = await takePrompt('the second chat message');
  const saved = await agentTurn(keep.turnId, `I will keep that for you.\n\n<joy-browser-remember name="Free pricing" match="127.0.0.1">\ndocument.querySelector('.price').textContent = 'FREE';\n</joy-browser-remember>`, 'the remember result');
  if (!/saved "Free pricing" for 127\.0\.0\.1/.test(saved.text) || !/OFF until the user approves/.test(saved.text)) throw new Error(`unexpected remember result:\n${saved.text}`);
  await say(saved.turnId, 'Saved. Approve it in the panel to switch it on.'); await endTurn(saved.turnId);
  await page.send('Page.reload'); await sleep(1500);
  if (await page.evaluate(`document.querySelector('.price').textContent`) !== '$49 / month') throw new Error('an UNAPPROVED script ran');
  const reopen = await until('the page button after reload', () => page.inWidget((n, attr) => attr(n, 'class')?.split(' ').includes('fab')));
  await page.click(reopen);
  const approve = await until('the approval card', () => page.inWidget((n, attr) => n.nodeName === 'BUTTON' && attr(n, 'class') === 'yes'));
  await page.click(approve);
  await until('the approval to be stored', async () => (await popup.evaluate(`chrome.storage.local.get('scripts').then((s) => s.scripts?.[0]?.approved === true && s.scripts[0].enabled === true)`)));
  await page.send('Page.reload');
  await until('the saved script to run on the next visit', () => page.evaluate(`document.querySelector('.price')?.textContent === 'FREE'`));
  step('remembered script: did NOT run while unapproved; approved in the panel; ran by itself on the next visit');

  // ── the brakes: an excluded site, then pause ──
  await press('Excluded sites');
  await until('the excluded-sites page', () => popup.evaluate(`!!document.querySelector('input[type=text]')`));
  await popup.evaluate(`document.querySelector('input[type=text]').value = '127.0.0.1'`);
  await press('Add');
  await until('the site in the list', () => popup.evaluate(`[...document.querySelectorAll('li code')].some((n) => n.textContent === '127.0.0.1')`));
  await until('the page button to leave the excluded site', async () => !(await page.widget()));
  await page.send('Page.reload'); await sleep(1500);
  if (await page.evaluate(`document.querySelector('.price').textContent`) !== '$49 / month') throw new Error('a saved script ran on an excluded site');
  if (await page.widget()) throw new Error('the page button came back on an excluded site');
  // The widget is gone from this site, so the next message comes from another client of the account.
  await w.sendAsAccount('Read the price again.');
  const again = await takePrompt('the third prompt');
  const refused = await agentTurn(again.turnId, `<joy-browser-execute url="${pageUrl}">\nreturn document.title;\n</joy-browser-execute>`, 'the refusal');
  if (!/status: error/.test(refused.text) || !/excluded-sites list/.test(refused.text)) throw new Error(`expected an excluded-site refusal, got:\n${refused.text}`);
  const listed = await agentTurn(refused.turnId, '<joy-browser-execute tab="list"></joy-browser-execute>', 'the tab list');
  if (listed.text.includes('127.0.0.1')) throw new Error(`an excluded tab was reported:\n${listed.text}`);
  step('excluded site: button gone, saved script silent, the agent is refused and the tab is not listed');
  await press('Back'); await until('the main page', async () => (await popupText()).includes('Pause'));
  await press('Pause');
  const paused = await agentTurn(listed.turnId, '<joy-browser-execute>\nreturn 1;\n</joy-browser-execute>', 'the paused refusal');
  if (!/status: error/.test(paused.text) || !/paused browser control/.test(paused.text)) throw new Error(`expected a paused refusal, got:\n${paused.text}`);
  step('paused: nothing runs, and the agent is told why');
  await endTurn(paused.turnId);

  // Stop the actual MV3 worker, then wake it through the popup. No in-memory
  // watcher/client survives; the persisted link, cursor and brakes must.
  const before = await popup.evaluate(`chrome.storage.local.get(['linked', 'cursor'])`);
  await popup.send('ServiceWorker.enable');
  await popup.send('ServiceWorker.stopAllWorkers');
  const resumed = await until('the restarted worker', () => popup.evaluate(`chrome.runtime.sendMessage({ type: 'status' })`).catch(() => null));
  if (resumed.linked?.sessionId !== before.linked.sessionId || resumed.starting || !resumed.paused) throw new Error('worker restart lost the linked session or pause setting');
  const cursor = await popup.evaluate(`chrome.storage.local.get('cursor').then((s) => s.cursor)`);
  if (cursor < before.cursor) throw new Error('worker restart moved the cursor backwards');
  await w.sendAsAccount('Check the browser after restarting.');
  const afterRestart = await takePrompt('the prompt after worker restart');
  const stillPaused = await agentTurn(afterRestart.turnId, '<joy-browser-execute>return 1;</joy-browser-execute>', 'the restarted watcher refusal');
  if (!/paused browser control/.test(stillPaused.text)) throw new Error(`restarted watcher did not preserve pause:\n${stillPaused.text}`);
  await endTurn(stillPaused.turnId);
  step('worker stopped and restarted: same session and cursor, watcher resumed, pause still enforced');
}

await run('joy-browser smoke test — Chromium', main);
