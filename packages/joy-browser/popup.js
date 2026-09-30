// The popup: two-step setup, then status, the pause switch and Settings.
// It holds no state of its own — every screen is drawn from the background's
// `status`, so it is always true to what is stored.
const api = globalThis.browser ?? globalThis.chrome;
const app = document.getElementById('app');
const ask = async (type, extra = {}) => { const r = await api.runtime.sendMessage({ type, ...extra }); if (!r || r.error) throw new Error(r?.error ?? 'The extension did not respond. Try again.'); return r; };
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); for (const k of kids) if (k != null) n.append(k); return n; };

let page = 'main'; // main | session | excluded | scripts | diagnostics
let flash = null;  // { bad, text } shown once at the top

let renderId = 0; let refresh = null;
async function render() {
  const id = ++renderId; clearTimeout(refresh);
  try {
  const st = await ask('status');
  if (id !== renderId) return;
  if (st.starting) refresh = setTimeout(() => render(), 750);
  app.replaceChildren();
  if (flash) { app.append(el('p', { className: flash.bad ? 'err' : 'ok', textContent: flash.text })); flash = null; }
  if (page === 'diagnostics') return await renderDiagnostics(st);
  if (st.stage === 'pair') return renderPair(st);
  if (st.stage === 'machine') return await renderMachine(st);
  return ({ main: renderMain, session: renderSession, excluded: renderExcluded, scripts: renderScripts, diagnostics: renderDiagnostics })[page](st);
  } catch (e) {
    if (id !== renderId) return;
    // The background did not answer: the one screen that needs nothing from it.
    app.replaceChildren(el('p', { className: 'err', textContent: e.message }), Object.assign(el('button', { textContent: 'Retry' }), { onclick: () => render() }));
    await renderDiagnostics(null, e);
  }
}
const go = (p) => { page = p; render(); };
const fail = (e) => { flash = { bad: true, text: e.message }; render(); };
const busy = (btn, label) => { btn.disabled = true; btn.textContent = label; };
const header = (title, back) => el('div', { className: 'row' }, el('h1', { textContent: title }), back ? Object.assign(el('button', { className: 'quiet', textContent: '‹ Back' }), { onclick: () => go('main') }) : null);

// ── setup ────────────────────────────────────────────────────────────────────
let typedCode = ''; // survives a failed try while this popup is open; never stored
function renderPair(st) {
  const relay = el('input', { type: 'text', placeholder: 'relay.example.com:4997', autocomplete: 'off', value: st.draft?.relayUrl ?? '' });
  const code = el('input', { type: 'password', placeholder: 'XXXXX-XXXXX-…', autocomplete: 'off', value: typedCode });
  const next = el('button', { textContent: 'Continue' });
  next.onclick = async () => {
    typedCode = code.value; busy(next, 'Checking…');
    try { await ask('login', { relayUrl: relay.value, backupCode: code.value }); typedCode = ''; render(); }
    catch (e) { fail(new Error(`Could not pair: ${e.message}`)); }
  };
  code.onkeydown = relay.onkeydown = (e) => { if (e.key === 'Enter') next.click(); };
  app.append(el('h1', { textContent: 'Pair this browser' }),
    el('p', { textContent: 'Your backup code is in the joy app under Settings → Account. It is the whole account and is kept in this browser profile until you clear it: pair only a profile you trust.' }),
    el('label', {}, 'Relay', relay), el('label', {}, 'Backup code', code), next,
    Object.assign(el('button', { className: 'quiet', textContent: 'Diagnostics' }), { onclick: () => go('diagnostics') }));
}

async function renderMachine(st) {
  app.append(el('h1', { textContent: 'Where should your session run?' }), el('p', { textContent: `Paired with ${st.relayUrl}. A headless session starts on the machine you pick and stays linked to this browser.` }));
  const select = el('select'); const folder = el('input', { type: 'text', value: st.defaultFolder });
  const start = el('button', { textContent: 'Start my session', disabled: true });
  const mode = el('select');
  mode.append(el('option', { value: 'relay', textContent: 'Relay — the session syncs to the joy app' }), el('option', { value: 'direct', textContent: 'Direct — peer to peer, kept off the relay' }));
  mode.value = st.mode ?? 'relay';
  const modeNote = el('p', { className: 's' });
  const explain = () => { modeNote.textContent = mode.value === 'direct' ? 'The browser connects straight to the machine over WebRTC. The relay only helps the two find each other; your messages never pass through it. The session stays on the machine and does not appear in the joy app.' : 'Messages go through your relay, end-to-end encrypted. The session also appears in the joy app.'; };
  mode.onchange = explain; explain();
  app.append(el('label', {}, 'Machine', select), el('label', {}, 'Folder on that machine (created if missing)', folder), el('label', {}, 'Connection', mode), modeNote, start, clearButton('Start over'));
  let machines = [];
  try { machines = (await ask('machines')).machines; } catch (e) { app.append(el('p', { className: 'err', textContent: e.message }), Object.assign(el('button', { textContent: 'Retry' }), { onclick: () => render() })); return; }
  if (!machines.length) { select.replaceWith(el('p', { className: 'err', textContent: 'This account has no machines yet. Install the joy daemon on one and pair it, then come back.' })); start.disabled = true; return; }
  for (const m of machines) select.append(el('option', { value: m.id, textContent: `${m.name}${m.online ? '' : ' (offline)'}`, disabled: !m.online }));
  const firstOnline = machines.find((m) => m.online); if (firstOnline) { select.value = firstOnline.id; start.disabled = false; } else start.disabled = true;
  start.onclick = async () => {
    busy(start, 'Starting… this can take a minute');
    const m = machines.find((x) => x.id === select.value);
    try { await ask('start', { machineId: m.id, machineName: m.name, cwd: folder.value, mode: mode.value }); flash = { text: 'Your session is running. Use the round J button on any page to talk to it.' }; render(); } catch (e) { fail(e); }
  };
}

// ── after setup ──────────────────────────────────────────────────────────────
function renderMain(st) {
  const s = st.linked;
  const pause = el('button', { className: st.paused ? '' : 'quiet', textContent: st.paused ? 'Resume' : 'Pause' });
  pause.onclick = async () => { try { await ask('pause', { paused: !st.paused }); render(); } catch (e) { fail(e); } };
  app.append(el('div', { className: 'row' }, el('h1', { textContent: 'Joy Browser' }), pause));
  if (st.starting) app.append(el('p', { textContent: 'Starting your session…' }));
  else if (s) app.append(el('div', { className: 'card' }, el('div', { className: `t ${st.paused ? '' : 'ok'}`, textContent: s.title ?? `session ${s.localId}` }), el('div', { className: 's', textContent: `${s.localId} · ${st.machineName ?? '?'} · ${st.cwd ?? ''}${s.direct ? ' · direct' : ''}` })));
  else {
    const again = el('button', { textContent: 'Start a session' });
    again.onclick = async () => { busy(again, 'Starting…'); try { await ask('newSession'); render(); } catch (e) { fail(e); } };
    app.append(el('p', { className: 'err', textContent: st.linkError ?? 'No session is linked.' }), again);
  }
  if (s && st.linkError) app.append(el('p', { className: 'err', textContent: st.linkError }));
  if (st.paused) app.append(el('p', { textContent: 'Paused: the agent cannot run anything in this browser, and saved scripts do not run.' }));
  const pending = st.scripts.filter((x) => !x.approved).length;
  const nav = (label, target, note) => { const b = el('button', { className: 'nav' }, el('span', { textContent: label }), el('span', { className: 's', textContent: note })); b.onclick = () => go(target); return b; };
  app.append(el('div', { className: 'navs' },
    nav('Session', 'session', s ? s.localId : 'none'),
    nav('Excluded sites', 'excluded', st.excluded.length ? `${st.excluded.length}` : 'none'),
    nav('Saved scripts', 'scripts', pending ? `${pending} waiting for you` : st.scripts.length ? `${st.scripts.filter((x) => x.enabled).length} on` : 'none'),
    nav('Diagnostics', 'diagnostics', '')),
    el('pre', { textContent: st.log.slice(-8).join('\n') || 'Nothing has happened yet.' }), clearButton('Clear everything'));
}

function renderSession(st) {
  const ref = el('input', { type: 'text', placeholder: 'session id, e.g. 1a2b3c4d', autocomplete: 'off' });
  const connect = el('button', { textContent: 'Connect' });
  connect.onclick = async () => { busy(connect, 'Connecting…'); try { await ask('connect', { ref: ref.value }); flash = { text: 'Connected.' }; go('main'); } catch (e) { fail(e); } };
  const fresh = el('button', { className: 'quiet', textContent: `Start a fresh session on ${st.machineName ?? 'the machine'}` });
  fresh.onclick = async () => { busy(fresh, 'Starting…'); try { await ask('newSession'); go('main'); } catch (e) { fail(e); } };
  app.append(header('Session', true),
    el('p', { textContent: st.linked ? `This browser is linked to ${st.linked.localId}${st.linked.title ? ` — ${st.linked.title}` : ''}. It stays linked until you change it here or clear everything.` : 'No session is linked.' }));
  const recent = st.recent.filter((r) => r.sessionId !== st.linked?.sessionId);
  if (recent.length) {
    const list = el('ul');
    for (const r of recent) {
      const back = el('button', { className: 'sm', textContent: 'Connect' });
      back.onclick = async () => { busy(back, '…'); try { await ask('connect', { ref: r.sessionId, direct: !!r.direct, machineId: r.machineId ?? null }); flash = { text: `Connected to ${r.localId}.` }; go('main'); } catch (e) { fail(e); } };
      list.append(el('li', { className: 'row' }, el('div', { className: 'l' }, el('div', { className: 't', textContent: r.title ?? `session ${r.localId}` }), el('div', { className: 's', textContent: `${r.localId}${r.machine ? ` · ${r.machine}` : ''}${r.direct ? ' · direct' : ''} · ${ago(r.at)}` })), back));
    }
    app.append(el('label', {}, 'Sessions this browser used before'), list);
  }
  app.append(el('label', {}, 'Connect to a specific session', ref), connect,
    el('p', { textContent: 'Use the id the app and `joy ls` show. The session is told a browser attached; only what its agent says from then on can run here.' }), fresh);
}
const ago = (t) => { const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };

function renderExcluded(st) {
  const input = el('input', { type: 'text', placeholder: 'bank.com   or   example.com/account/*', autocomplete: 'off' });
  const add = el('button', { textContent: 'Add' });
  const submit = async () => { try { await ask('exclude:add', { pattern: input.value }); render(); } catch (e) { fail(e); } };
  add.onclick = submit; input.onkeydown = (e) => { if (e.key === 'Enter') submit(); };
  const list = el('ul');
  for (const p of st.excluded) { const rm = el('button', { className: 'quiet sm', textContent: 'Remove' }); rm.onclick = async () => { try { await ask('exclude:remove', { pattern: p }); render(); } catch (e) { fail(e); } }; list.append(el('li', { className: 'row' }, el('code', { textContent: p }), rm)); }
  app.append(header('Excluded sites', true),
    el('p', { textContent: 'On these sites there is no page button, the agent cannot run scripts, saved scripts do not run, and their tabs are left out of what the agent is told. A site covers its subdomains; add a path to cover only part of one.' }),
    el('div', { className: 'row' }, input, add), st.excluded.length ? list : el('p', { textContent: 'Nothing is excluded yet. “Hide on this site” in the chat panel adds the site you are on.' }));
}

function renderScripts(st) {
  app.append(header('Saved scripts', true), el('p', { textContent: 'Scripts the agent asked to keep. An approved script that is on runs on every visit to its sites, with nobody watching, so each one stays off until you approve it. Excluded sites and Pause always win.' }));
  if (!st.scripts.length) return void app.append(el('p', { textContent: 'None yet. Ask your session to remember a script for a site.' }));
  const list = el('ul');
  for (const s of st.scripts) {
    const act = async (patch) => { try { await ask('scripts:set', { id: s.id, revision: s.revision, ...patch }); render(); } catch (e) { fail(e); } };
    const main = s.approved ? Object.assign(el('button', { className: s.enabled ? 'sm' : 'quiet sm', textContent: s.enabled ? 'On' : 'Off' }), { onclick: () => act({ enabled: !s.enabled }) }) : Object.assign(el('button', { className: 'sm', textContent: 'Approve' }), { onclick: () => act({ approved: true, enabled: true }) });
    const del = Object.assign(el('button', { className: 'quiet sm', textContent: s.approved ? 'Delete' : 'Reject' }), { onclick: () => act({ remove: true }) });
    list.append(el('li', {}, el('div', { className: 'row' }, el('div', { className: 't', textContent: s.name }), el('div', { className: 'btns' }, main, del)),
      el('div', { className: 's', textContent: `${s.approved ? '' : 'waiting for you · '}${s.match.join(', ')}` }),
      el('details', {}, el('summary', { textContent: 'show the script' }), el('pre', { textContent: s.code }))));
  }
  app.append(list);
}

/** Everything a person can paste when it misbehaves in a browser we cannot
 *  run ourselves. The popup's own half needs no background at all. */
async function collectDiagnostics(background, failure) {
  const ua = globalThis.navigator?.userAgent ?? 'unknown';
  const d = {
    browser: /Orion/i.test(ua) ? 'Orion' : /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari (WebKit)' : 'unknown',
    userAgent: ua, extension: api.runtime.getManifest?.().version ?? '?', manifestVersion: api.runtime.getManifest?.().manifest_version ?? '?',
    popupSees: { alarms: !!api.alarms, debugger: !!api.debugger, tabsExecuteScript: typeof api.tabs?.executeScript === 'function', scripting: !!api.scripting, storage: !!api.storage?.local, runtimeConnect: typeof api.runtime?.connect === 'function', promisesApi: !!globalThis.browser },
  };
  if (failure) d.backgroundError = failure.message;
  d.background = background ?? 'no answer from the background — it is not running, or it failed while loading';
  return d;
}
async function renderDiagnostics(st, failure = null) {
  let bg = null;
  if (st) { try { bg = await Promise.race([ask('diagnostics'), new Promise((_, rej) => setTimeout(() => rej(new Error('no answer in 5 s')), 5000))]); } catch (e) { failure = failure ?? e; } }
  const text = JSON.stringify(await collectDiagnostics(bg, failure), null, 2);
  const pre = el('pre', { textContent: text });
  const copy = el('button', { textContent: 'Copy' });
  copy.onclick = async () => { try { await navigator.clipboard.writeText(text); copy.textContent = 'Copied'; } catch { const r = document.createRange(); r.selectNodeContents(pre); getSelection().removeAllRanges(); getSelection().addRange(r); copy.textContent = 'Select and copy'; } };
  app.append(st ? header('Diagnostics', true) : el('h1', { textContent: 'Diagnostics' }),
    el('p', { textContent: 'What this browser gives the extension, and what the extension has stored — no secrets. Copy it and send it to whoever is helping you.' }), copy, pre);
}

function clearButton(label) {
  const b = el('button', { className: 'quiet danger', textContent: label });
  b.onclick = async () => { if (label === 'Clear everything' && !confirm('Forget the backup code, the linked session, excluded sites and saved scripts?')) return; try { await ask('clear'); page = 'main'; render(); } catch (e) { fail(e); } };
  return b;
}

api.storage.onChanged.addListener((changes) => { if (page === 'main' && (changes.log || changes.linked || changes.linkError || changes.relayError || changes.scripts)) render(); });
render().catch((e) => { app.replaceChildren(el('p', { className: 'err', textContent: e.message })); });
