#!/usr/bin/env node
// Direct mode in a REAL Firefox — by hand, like firefox-smoke.mjs:
//
//   node test/direct-smoke-firefox.mjs /path/to/firefox /path/to/geckodriver
//
// Firefox holds the peer in its background page itself (no offscreen
// document). Same scenario as direct-smoke-chrome.mjs, up to the worker
// restart, which Firefox's persistent background page does not have.
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { EXT, sleep, until, step, cleanup, run, startWorld, startDirectDaemon, DIRECT_MACHINE } from './smoke-lib.mjs';

const [FIREFOX, GECKO] = process.argv.slice(2);
if (!FIREFOX || !GECKO) { console.error('usage: node test/direct-smoke-firefox.mjs /path/to/firefox /path/to/geckodriver'); process.exit(2); }
const ADDON_ID = JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(join(EXT, 'manifest.firefox.json'))}).browser_specific_settings.gecko.id))`]).toString());
const UUID = '6a0f3c1e-5d2b-4e7a-9c11-0b5e2d7f4a90';

async function main() {
  execFileSync(process.execPath, [join(EXT, 'build.mjs')], { stdio: 'ignore' });
  const w = await startWorld();
  const d = await startDirectDaemon(w);

  const port = 20000 + Math.floor(Math.random() * 20000);
  const gecko = spawn(GECKO, ['--port', String(port), '--allow-system-access'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_HEADLESS: '1' } });
  cleanup.push(() => gecko.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  await until('geckodriver', () => fetch(`${base}/status`).then((r) => r.ok, () => false));
  const wd = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${j.value?.message ?? r.status}`);
    return j.value;
  };
  const { sessionId: sid } = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'moz:firefoxOptions': { binary: FIREFOX, args: ['-headless', '-width', '1100', '-height', '800'], prefs: { 'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: UUID }) } } } } });
  cleanup.push(() => wd('DELETE', `/session/${sid}`).catch(() => {}));
  const S = (method, path, body) => wd(method, `/session/${sid}${path}`, body);
  await S('POST', '/moz/addon/install', { path: join(EXT, 'dist/firefox'), temporary: true });
  const js = (script, ...args) => S('POST', '/execute/sync', { script, args });
  step(`Firefox up, ${ADDON_ID} installed from dist/firefox`);

  const before = await S('GET', '/window/handles');
  await S('POST', '/moz/context', { context: 'chrome' });
  await js(`const w = Services.wm.getMostRecentWindow('navigator:browser'); w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, `moz-extension://${UUID}/popup.html`);
  await S('POST', '/moz/context', { context: 'content' });
  const popupWin = await until('the popup tab', async () => (await S('GET', '/window/handles')).find((h) => !before.includes(h)));
  await S('POST', '/window', { handle: popupWin });
  const popupText = () => js('return document.body.innerText');
  const press = (label) => js(`const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes(arguments[0])); if (!b) throw new Error('no button: ' + arguments[0] + ' in: ' + document.body.innerText); b.click();`, label);
  await until('the pairing form', () => js(`return !!document.querySelector('input[type=password]')`));
  await js(`const [relay, code] = document.querySelectorAll('input'); relay.value = arguments[0]; code.value = arguments[1];`, w.relayUrl, w.backupCode);
  await press('Continue');
  await until('the direct machine, online', () => js(`return [...document.querySelectorAll('option')].some((o) => o.textContent === 'direct-box' && !o.disabled)`)).catch(async (e) => { throw new Error(`${e.message} — popup shows: ${await popupText()}`); });
  await js(`const [machine, mode] = document.querySelectorAll('select'); machine.value = arguments[0]; mode.value = 'direct'; mode.dispatchEvent(new Event('change'));`, DIRECT_MACHINE);
  await press('Start my session');

  const diag = () => js(`return browser.runtime.sendMessage({ type: 'diagnostics' })`);
  const hello = await d.takePrompt('the browser hello, over the data channel').catch(async (e) => { throw new Error(`${e.message} — popup: ${await popupText()}\n${d.log()}\ndiagnostics: ${JSON.stringify(await diag())}`); });
  if (!/^<joy-message from="browser">\nA browser is now attached/.test(hello.text)) throw new Error(`unexpected hello: ${hello.text}`);
  const { specs } = await d.state();
  if (specs[0]?.localOnly !== true) throw new Error(`the session was not local-only: ${JSON.stringify(specs[0])}`);
  if ((await diag()).direct?.rtcHere !== true) throw new Error('the peer is not in the background page');
  step('Direct: local-only session created; the background page holds the peer; the hello arrived peer to peer');

  const answer = await d.agentTurn(hello.id, `<joy-browser-execute url="${w.pageUrl}">\nreturn document.querySelector(".price").textContent;\n</joy-browser-execute>`, 'the script result');
  if (!/status: ok/.test(answer.text) || !/\$49 \/ month/.test(answer.text)) throw new Error(`unexpected result:\n${answer.text}`);
  await d.say(hello.id, 'Done.', true);
  step('the agent\'s script ran through tabs.executeScript; its result went back to the daemon');

  const pageWin = (await S('POST', '/window/new', { type: 'tab' })).handle;
  await S('POST', '/window', { handle: pageWin });
  await S('POST', '/url', { url: w.pageUrl });
  await until('the page button', () => js(`return !!document.querySelector('joy-browser-root')`));
  const [vw, vh] = await js('return [innerWidth, innerHeight]');
  await S('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(vw - 35), y: Math.round(vh - 35), duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
  await sleep(400);
  const text = 'What does the Pro plan cost?';
  await S('POST', '/actions', { actions: [{ type: 'key', id: 'keys', actions: [...text, '\uE007'].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }] });
  const asked = await d.takePrompt('the chat message');
  if (asked.text !== text) throw new Error(`the chat message arrived as ${JSON.stringify(asked.text)}`);
  step('page button → panel: a click and real typing reached the daemon');

  const { sessions = [] } = await w.api('GET', '/sessions');
  if (sessions.length) throw new Error(`the relay holds ${sessions.length} session(s)`);
  step('the relay lists no session for the account');
}

await run('joy-browser Direct smoke test — Firefox', main);
