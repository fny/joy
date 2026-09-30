// Joy Browser — the background half (a service worker in Chrome, a background
// page in Firefox; the same code).
//
// A client of ONE joy account, paired from its backup code like the MCP
// server. In Relay mode it talks only to the relay. In Direct mode the session
// is local-only on the machine, and the extension reaches the daemon's API
// peer to peer over WebRTC (src/direct.js) — the relay carries only the setup.
// v1 ties ONE session to the browser: on
// setup it starts a headless session on the machine you chose, links to it and
// remembers it. From then on it
//   · runs what that session's agent emits as <joy-browser-execute>,
//   · saves what it emits as <joy-browser-remember> — which stays OFF until
//     you approve it — and runs approved scripts on every matching page load,
//   · feeds the chat panel the page button opens (content.js),
// all of it subject to two brakes the agent cannot reach: the pause switch and
// the excluded-sites list.
import { api } from './src/api.js';
import { parseBackupCode, contentKeyPair, relayPerimeterKey, openSessionKeyEnvelope, openCard, openMachineKey, openMachineMetadata, sealSpawnSpec, b64, unb64 } from './src/crypto.js';
import { DirectClient, peerOpenerFor } from './src/direct.js';
import { loginWithSecret, RelayClient, relayAddress, describeRelay } from './src/relay.js';
import { Watcher } from './src/watcher.js';
import { browserMessage, splitMatch } from './src/tags.js';
import { matchesAny, normalizePattern } from './src/patterns.js';
import { foldEvents } from './src/conversation.js';
import { runInTab, tabInfo, withTimeout } from './src/runner.js';
import { serial, sameLink, boundedRelay } from './src/state.js';

const ALARM = 'joy-browser-poll';
const LOAD_TIMEOUT_MS = 30_000;
const DEFAULT_FOLDER = '~/joy-browser';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wiring that must not take the whole background down when a browser lacks an
// API: each piece is tried on its own, and what failed is reported by
// `diagnostics` — the popup shows it — instead of being a silent dead worker.
const startupErrors = [];
const wire = (what, fn) => { try { fn(); } catch (e) { startupErrors.push(`${what}: ${e?.message ?? e}`); } };

// ── state ────────────────────────────────────────────────────────────────────
// storage.local — the background can be stopped at any moment, so nothing that
// matters lives only in memory:
//   setup    { relayUrl, secret (b64), machineId, machineName, cwd, mode: 'relay' | 'direct' }
//   linked   { sessionId, token, localId, title, envelope, direct?, machineId? } | null     cursor  number
//   recent   [{ sessionId, localId, title, machine, at, direct? }]  — newest first, the linked one included; Settings → Session offers them back
//   pendingSpawn { id, machineId, wire, relayId?, retried? } | null
//   pendingResult { id, text } | null   — delivery retries never rerun code
//   paused   boolean          excluded [pattern]          fab { x, y }
//   scripts  [{ id, name, match[], code, enabled, approved, createdAt }]
//   linkError string | null   log [line]
const get = (keys) => api.storage.local.get(keys);
const writes = serial();
let epoch = 0;
const current = (gen) => { if (gen !== epoch) throw new Error('the browser connection changed; try again'); };
const set = (obj, gen = epoch) => writes(() => { current(gen); return api.storage.local.set(obj); });
const change = (keys, fn, gen = epoch) => writes(async () => {
  current(gen); const s = await get(keys); current(gen);
  const patch = fn(s); if (patch) await api.storage.local.set(patch);
  return patch;
});

async function log(line, gen = epoch) {
  await change('log', ({ log: lines = [] }) => ({ log: [...lines, `${new Date().toLocaleTimeString()}  ${line}`].slice(-80) }), gen);
}

async function report(e, gen = epoch) {
  if (gen !== epoch) return;
  const message = e?.message ?? String(e);
  try { await set({ relayError: message }, gen); await log(message, gen); current(gen); post({ type: 'error', message }); } catch { /* storage or port unavailable */ }
}
const background = (job) => { const gen = epoch; void Promise.resolve().then(job).catch((e) => report(e, gen)); };

let client = null; // { relay, contentSecret } — rebuilt from storage on demand
let clientJob = null;
async function ensureClient() {
  if (client) return client;
  if (clientJob) return clientJob;
  const gen = epoch;
  const job = (async () => {
    const { setup } = await get('setup');
    if (!setup?.relayUrl || !setup?.secret) return null;
    const accountSecret = unb64(setup.secret);
    const perimeterKey = relayPerimeterKey(accountSecret);
    const renew = () => withTimeout(loginWithSecret(setup.relayUrl, accountSecret, { perimeterKey }), 20_000, 'relay login');
    const token = await renew(); current(gen);
    client = { relay: boundedRelay(new RelayClient({ relayUrl: setup.relayUrl, token, perimeterKey, renew }), withTimeout), contentSecret: contentKeyPair(accountSecret).secretKey };
    return client;
  })();
  clientJob = job;
  try { return await job; } finally { if (clientJob === job) clientJob = null; }
}
const keyOf = (linked, c) => (linked?.envelope ? openSessionKeyEnvelope(linked.envelope, c.contentSecret) : null);

/** Direct mode's client for one machine, built on first use. The relay is
 *  asked once for the machine's key: both ends derive the tunnel key that
 *  seals the WebRTC setup from it. */
async function directOf(c, machineId) {
  if (c.direct?.machineId === machineId) return c.direct;
  const job = c.directJobs?.get(machineId);
  if (job) return job;
  c.directJobs ??= new Map();
  const building = (async () => {
    const { machines = [] } = await c.relay.listMachines();
    const m = machines.find((x) => x.id === machineId);
    if (!m) throw new Error('that machine is no longer on this account');
    const machineKey = openMachineKey(m.dataEncryptionKey, c.contentSecret);
    if (!machineKey) throw new Error('this browser cannot open the machine\'s key, so Direct mode cannot reach it — use Relay mode');
    c.direct?.close();
    c.direct = boundedRelay(new DirectClient({ relay: c.relay, machineId, machineKey, openPeer: peerOpenerFor(api) }), withTimeout);
    return c.direct;
  })().finally(() => c.directJobs.delete(machineId));
  c.directJobs.set(machineId, building);
  return building;
}
/** What a linked session is reached through: its daemon (Direct) or the relay. */
async function via(linked, c) {
  if (!linked?.direct) return c.relay;
  return directOf(c, linked.machineId ?? (await get('setup')).setup?.machineId);
}

// ── the two brakes ───────────────────────────────────────────────────────────
const brakes = async () => { const { paused = false, excluded = [] } = await get(['paused', 'excluded']); return { paused, excluded }; };
const PAUSED = 'the user has paused browser control in the Joy Browser extension. Nothing ran. Tell them, and wait until they resume it.';
const excludedError = (url) => `${url} is on the user's excluded-sites list, so the extension will not run scripts there or report on it. Do not try to work around this; tell the user if the task needs that site.`;

// ── running scripts ──────────────────────────────────────────────────────────
// One at a time, agent scripts and saved scripts alike: two debugger sessions
// on one tab refuse each other.
let runQueue = Promise.resolve();
const queued = (fn) => { const p = runQueue.then(fn, fn); runQueue = p.catch(() => {}); return p; };

const scriptable = (url) => /^https?:|^file:/.test(url ?? '');
async function activeTab() {
  let [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || !scriptable(tab.url)) {
    // The last focused window can be DevTools or an extension page.
    const candidates = await api.tabs.query({ active: true, windowType: 'normal' });
    tab = candidates.find((t) => scriptable(t.url)) ?? tab;
  }
  return tab ?? null;
}
async function waitForLoad(tabId) {
  let done; let removed;
  try { return await withTimeout(new Promise((resolve, reject) => {
    done = (id, info) => { if (id === tabId && info.status === 'complete') resolve(); };
    removed = (id) => { if (id === tabId) reject(new Error('the tab was closed before it loaded')); };
    api.tabs.onUpdated.addListener(done);
    api.tabs.onRemoved.addListener(removed);
    api.tabs.get(tabId).then((t) => { if (t.status === 'complete') resolve(); }, reject);
  }), LOAD_TIMEOUT_MS, 'page load'); }
  finally { api.tabs.onUpdated.removeListener(done); api.tabs.onRemoved.removeListener(removed); }
}

async function execute(tag) {
  const gen = epoch;
  const { paused, excluded } = await brakes();
  if (paused) return { tab: null, error: PAUSED };
  if (tag.attrs.tab === 'list') {
    const all = await api.tabs.query({}); const b = await brakes(); current(gen);
    if (b.paused) return { tab: null, error: PAUSED };
    const tabs = all.filter((t) => t.url && !matchesAny(t.url, b.excluded));
    return { tab: null, value: 'the open tabs follow (tabs on excluded sites are not listed)', tabs: tabs.slice(0, 40).map((t) => ({ ...tabInfo(t), active: t.active })) };
  }
  let tab;
  if (tag.attrs.url) {
    if (!/^https?:\/\//i.test(tag.attrs.url)) return { tab: null, error: `url must be http(s): ${tag.attrs.url}` };
    if (matchesAny(tag.attrs.url, excluded)) return { tab: null, error: excludedError(tag.attrs.url) };
    tab = await api.tabs.create({ url: tag.attrs.url, active: true });
    try { await waitForLoad(tab.id); } catch (e) { return { tab: tabInfo(tab), error: e.message }; }
    tab = await api.tabs.get(tab.id);
  } else if (tag.attrs.tab && /^\d+$/.test(tag.attrs.tab)) {
    tab = await api.tabs.get(Number(tag.attrs.tab)).catch(() => null);
    if (!tab) return { tab: null, error: `no tab ${tag.attrs.tab} — use tab="list" to see the open tabs` };
  } else {
    tab = await activeTab();
    if (!tab) return { tab: null, error: 'no active tab to run in — open a page with the url attribute' };
  }
  // Checked on the page the script would actually touch — a redirect can land
  // an allowed URL on an excluded site.
  const latest = await brakes(); current(gen);
  if (latest.paused) return { tab: null, error: PAUSED };
  if (matchesAny(tab.url, latest.excluded)) return { tab: null, error: excludedError(new URL(tab.url).host) };
  if (!tag.code.trim()) return { tab: tabInfo(tab), value: tag.attrs.url ? 'opened and loaded' : 'nothing to run (empty script)' };
  return queued(async () => {
    current(gen);
    const now = await api.tabs.get(tab.id); const b = await brakes(); current(gen);
    if (b.paused) return { tab: null, error: PAUSED };
    if (matchesAny(now.url, b.excluded)) return { tab: null, error: excludedError(now.url) };
    return runInTab(now, tag.code);
  });
}

// ── saved scripts ────────────────────────────────────────────────────────────
async function remember(tag) {
  const name = (tag.attrs.name ?? '').trim().slice(0, 80) || 'untitled script';
  const match = [...new Set(splitMatch(tag.attrs.match).map(normalizePattern).filter(Boolean))];
  if (!match.length) return { note: `"${name}" was NOT saved: match must name at least one site, for example match="example.com" or match="example.com/app/*".` };
  if (!tag.code.trim()) return { note: `"${name}" was NOT saved: the script is empty.` };
  let existing;
  // A changed script goes back to unapproved: approval is of THIS code, on THESE sites.
  await change('scripts', ({ scripts = [] }) => {
    existing = scripts.find((s) => s.name === name);
    const entry = { id: existing?.id ?? crypto.randomUUID(), revision: crypto.randomUUID(), name, match, code: tag.code, enabled: false, approved: false, createdAt: Date.now() };
    return { scripts: [...scripts.filter((s) => s.id !== entry.id), entry] };
  });
  await broadcastMeta();
  return { note: `saved "${name}" for ${match.join(', ')}${existing ? ' (replacing the earlier version)' : ''}. It is OFF until the user approves it in the chat panel or under Settings → Saved scripts; you cannot approve it for them. Once on, it runs on every visit to those pages, except excluded sites.` };
}

async function runSavedScripts(tab) {
  const gen = epoch;
  if (!scriptable(tab.url) || tab.url.startsWith('file:')) return;
  const { scripts = [] } = await get('scripts');
  const due = scripts.filter((s) => s.enabled && s.approved && matchesAny(tab.url, s.match));
  if (!due.length) return;
  const { paused, excluded } = await brakes();
  if (paused || matchesAny(tab.url, excluded)) return;
  for (const s of due) {
    const r = await queued(async () => {
      current(gen);
      const now = await api.tabs.get(tab.id); const b = await brakes();
      const { scripts: latest = [] } = await get('scripts'); current(gen);
      const approved = latest.find((x) => x.id === s.id && x.code === s.code && x.revision === s.revision && x.enabled && x.approved);
      if (!approved || b.paused || matchesAny(now.url, b.excluded) || !matchesAny(now.url, approved.match)) return { error: 'skipped: script, page, or browser controls changed while waiting' };
      return runInTab(now, approved.code);
    });
    await log(`saved script "${s.name}" on ${new URL(tab.url).host}: ${r.error ? `error — ${String(r.error).split('\n')[0]}` : 'ok'}`, gen);
  }
}
wire('tabs.onUpdated', () => api.tabs.onUpdated.addListener((_id, info, tab) => { if (info.status === 'complete') background(() => runSavedScripts(tab)); }));

// ── the chat feed ────────────────────────────────────────────────────────────
const ports = new Set();
let convo = { sessionId: null, rows: new Map(), working: false, lastSeq: 0, loaded: false };
let conversationJob = null;
const convoRows = () => [...convo.rows.values()].sort((a, b) => a.seq - b.seq);
const post = (msg) => { for (const p of ports) { try { p.postMessage(msg); } catch { ports.delete(p); try { p.disconnect(); } catch { /* gone */ } } } };

function absorb(events, key) {
  const fresh = (events ?? []).filter((e) => Number.isSafeInteger(Number(e?.seq)) && Number(e.seq) > convo.lastSeq).sort((a, b) => Number(a.seq) - Number(b.seq));
  if (!fresh.length) return [];
  const { rows, working } = foldEvents(fresh, key, convo.working);
  convo.working = working;
  convo.lastSeq = Math.max(convo.lastSeq, ...fresh.map((e) => Number(e.seq)));
  for (const r of rows) convo.rows.set(r.seq, r);
  while (convo.rows.size > 300) convo.rows.delete(convo.rows.keys().next().value);
  return rows;
}

async function loadConversation() {
  if (conversationJob) return conversationJob;
  const gen = epoch;
  const job = refreshConversation(gen);
  conversationJob = job;
  try { return await job; } finally { if (conversationJob === job) conversationJob = null; }
}
async function refreshConversation(gen) {
  const { linked } = await get('linked');
  const c = linked ? await ensureClient() : null;
  current(gen);
  if (!linked || !c) { convo = { sessionId: null, rows: new Map(), working: false, lastSeq: 0, loaded: false }; return; }
  const initial = convo.sessionId !== linked.sessionId || !convo.loaded;
  if (initial) convo = { sessionId: linked.sessionId, rows: new Map(), working: false, lastSeq: 0, loaded: false, pending: [] };
  const target = convo;
  const t = await via(linked, c);
  const st = await t.sessionState(linked.sessionId);
  const page = initial ? await t.eventsBefore(linked.sessionId, Number(st.headSeq) + 1, 120) : await t.events(linked.sessionId, target.lastSeq, 200);
  current(gen);
  if (convo !== target || !sameLink(linked, (await get('linked')).linked)) return;
  absorb(page?.messages ?? [], keyOf(linked, c));
  // The relay is the authority on whether a turn is open right now; the fold
  // only knows what the last page of history happened to contain.
  const exec = st.execution?.state ?? st.execution ?? 'idle';
  // A newer terminal can arrive while the state/history requests are in flight.
  if (convo.lastSeq <= Number(st.headSeq)) convo.working = exec !== 'idle';
  if (initial) absorb(target.pending ?? [], keyOf(linked, c));
  convo.loaded = true;
  convo.pending = [];
  if (ports.size) post({ type: 'state', sessionId: linked.sessionId, rows: convoRows(), working: convo.working, ...(await metaView()) });
}

async function metaView() {
  const { linked, paused = false, scripts = [], linkError = null, relayError = null, setup } = await get(['linked', 'paused', 'scripts', 'linkError', 'relayError', 'setup']);
  return { session: linked ? { sessionId: linked.sessionId, localId: linked.localId, title: linked.title ?? null, machine: setup?.machineName ?? null } : null, paused, linkError: linkError ?? relayError, pending: scripts.filter((s) => !s.approved).map(({ id, revision, name, match, code }) => ({ id, revision, name, match, code })) };
}
async function broadcastMeta() { if (ports.size) post({ type: 'meta', ...(await metaView()) }); }

async function sendAsUser(text, id) {
  const gen = epoch;
  const { linked } = await get('linked');
  const c = await ensureClient();
  if (!linked || !c) throw new Error('no session is linked');
  if (!text.trim()) throw new Error('enter a message');
  current(gen);
  await (await via(linked, c)).sendText(linked.sessionId, text, keyOf(linked, c), id);
  background(() => ensureWatching());
}

wire('runtime.onConnect', () => api.runtime.onConnect.addListener(portOpened));
function portOpened(port) {
  if (port.name !== 'joy-chat') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));
  port.onMessage.addListener(async (m) => {
    try {
      if (m.type === 'hello') {
        port.postMessage({ type: 'pong' });
        await loadConversation(); background(() => ensureWatching());
        port.postMessage({ type: 'state', rows: convoRows(), working: convo.working, ...(await metaView()) });
      } else if (m.type === 'send') { await sendAsUser(String(m.text ?? ''), m.id); port.postMessage({ type: 'sent', id: m.id }); }
      else if (m.type === 'ping') { port.postMessage({ type: 'pong' }); background(() => ensureWatching()); }
      else if (m.type === 'script') { await handlers['scripts:set']({ id: m.id, revision: m.revision, approved: m.approve, enabled: m.approve, remove: !m.approve }); }
      else if (m.type === 'pause') { await handlers.pause({ paused: !!m.paused }); }
      else if (m.type === 'hideHere') { await handlers['exclude:add']({ pattern: m.host }); }
    } catch (e) { try { port.postMessage({ type: 'error', id: m?.type === 'send' ? m.id : null, message: e?.message ?? String(e) }); } catch { /* gone */ } }
  });
}

// ── watching the linked session ──────────────────────────────────────────────
const store = {
  async load() {
    const { linked, cursor, pendingResult } = await get(['linked', 'cursor', 'pendingResult']);
    const c = linked ? await ensureClient() : null;
    return linked && c ? { ...linked, cursor, pendingResult, key: keyOf(linked, c) } : null;
  },
  saveCursor: async (cursor, state) => !!await change(['linked', 'cursor'], (s) => sameLink(s.linked, state) && cursor > (Number(s.cursor) || 0) ? { cursor } : null),
  saveResult: async (pendingResult, state) => !!await change('linked', (s) => sameLink(s.linked, state) ? { pendingResult } : null),
  clearResult: async (id, state) => !!await change(['linked', 'pendingResult'], (s) => sameLink(s.linked, state) && s.pendingResult?.id === id ? { pendingResult: null } : null),
};

let watcher = null; let stopStream = null; let watching = null;
const watchQueue = serial();
let watchJob = null;
function stopWatching() { watcher?.stop(); stopStream?.(); stopStream = null; watcher = null; watching = null; conversationJob = null; convo = { sessionId: null, rows: new Map(), working: false, lastSeq: 0, loaded: false }; }
async function ensureWatching() {
  const gen = epoch;
  if (watchJob?.gen === gen) return watchJob.promise;
  const job = { gen, promise: null };
  job.promise = watchQueue(async () => { current(gen); return watchOnce(gen); }).finally(() => { if (watchJob === job) watchJob = null; });
  watchJob = job; return job.promise;
}
async function watchOnce(gen) {
  const { linked } = await get('linked');
  const c = linked ? await ensureClient() : null;
  current(gen);
  if (linked && !sameLink(linked, (await get('linked')).linked)) return;
  if (!linked || !c) return stopWatching();
  const t = await via(linked, c); current(gen);
  if (watching !== linked.sessionId) { stopWatching(); watching = linked.sessionId; }
  if (!watcher) {
    watcher = new Watcher({ relay: t, store, execute, remember, log: (line) => log(line, gen), onEvents: (events, key) => {
      if (gen !== epoch || convo.sessionId !== linked.sessionId) return;
      if (!convo.loaded) { convo.pending?.push(...events); return; }
      const rows = absorb(events, key);
      if (rows.length || ports.size) post({ type: 'rows', sessionId: linked.sessionId, rows, working: convo.working });
    } });
  }
  if (!stopStream) {
    stopStream = t.stream({
      sessionId: linked.sessionId,
      onPoke: (sessionId) => { if (gen === epoch && sessionId === linked.sessionId) background(() => ensureWatching()); },
      onError: (e) => { if (gen === epoch) background(() => report(e, gen)); },
    });
  }
  await watcher.poll(); current(gen);
  await set({ relayError: null, linkError: null }, gen);
  if (ports.size) { await loadConversation(); await broadcastMeta(); }
}

// ── the linked session ───────────────────────────────────────────────────────
async function link(row, { announce, gen = epoch }) {
  const c = await ensureClient(); current(gen);
  const key = openSessionKeyEnvelope(row.sessionKeyEnvelope, c.contentSecret);
  const meta = row.encryptedMetadata ? openCard(row.encryptedMetadata, key) : null;
  const linked = { sessionId: row.sessionId, token: crypto.randomUUID(), localId: row.localSessionId ?? row.sessionId.slice(0, 8), title: meta?.summary?.text ?? null, envelope: row.sessionKeyEnvelope ?? null };
  await attach(linked, { announce, gen, machine: meta?.host ?? null });
}

/** A Direct-mode session: its id on the daemon is the only id it has. */
const directLink = (id, machineId, title = null) => ({ sessionId: id, token: crypto.randomUUID(), localId: id, title, envelope: null, direct: true, machineId });

async function attach(linked, { announce, gen, machine = null }) {
  const c = await ensureClient(); current(gen);
  const t = await via(linked, c); current(gen);
  let pendingResult = null;
  if (announce) {
    const tab = await activeTab();
    const { excluded = [] } = await get('excluded');
    const here = tab && !matchesAny(tab.url, excluded) ? `The active tab is ${tab.id} · ${tab.url} · "${tab.title}".` : 'Open a page with the url attribute when you need one.';
    pendingResult = { id: crypto.randomUUID(), text: browserMessage(`A browser is now attached to this session: the user's own, through the Joy Browser extension. You can run JavaScript in it with <joy-browser-execute> and offer to save scripts with <joy-browser-remember>, as your instructions describe. ${here} The user talks to you from a chat panel on the pages they browse. Nothing is being asked of you by this message — reply with one short line saying you are ready.`) };
  }
  // Use a fresh head, not the earlier list snapshot. Persist the notice with
  // the link: a failed delivery must not make the next attempt spawn again.
  const st = await t.sessionState(linked.sessionId); current(gen);
  if (!Number.isSafeInteger(Number(st.headSeq)) || Number(st.headSeq) < 0) throw new Error('the relay returned an invalid session cursor');
  await set({ linked, cursor: Number(st.headSeq), pendingResult, pendingSpawn: null, linkError: null, relayError: null }, gen);
  // Remember it, so a later switch can come straight back without the id.
  await change(['recent', 'setup'], (s) => ({ recent: [{ sessionId: linked.sessionId, localId: linked.localId, title: linked.title, machine: machine ?? s.setup?.machineName ?? null, at: Date.now(), ...(linked.direct ? { direct: true, machineId: linked.machineId } : {}) }, ...(s.recent ?? []).filter((r) => r.sessionId !== linked.sessionId)].slice(0, 8) }), gen);
  stopWatching();
  await log(`linked to session ${linked.localId}${linked.title ? ` — ${linked.title}` : ''}${linked.direct ? ' (direct)' : ''}`, gen);
  await ensureWatching(); await loadConversation(); await broadcastMeta();
}

let spawning = null;
function startSession() {
  if (spawning) return spawning;
  const gen = epoch;
  const job = (async () => {
    try {
      await set({ linkError: null }, gen);
      const c = await ensureClient();
      const { setup, pendingSpawn } = await get(['setup', 'pendingSpawn']); current(gen);
      if (!c || !setup?.machineId) throw new Error('setup is not finished');
      if (setup.mode === 'direct') {
        const d = await directOf(c, setup.machineId); current(gen);
        const folder = setup.cwd || DEFAULT_FOLDER;
        const rec = await d.createSession({ cwd: folder, agent: 'claude', createDir: true, headless: true }); current(gen);
        if (!rec?.id) throw new Error('the machine did not return a session id');
        await log(`started a direct session on ${setup.machineName ?? 'the machine'} in ${folder}`, gen);
        await attach(directLink(rec.id, setup.machineId), { announce: true, gen });
        return;
      }
      let pending = pendingSpawn;
      if (!pending) {
        const { machines = [] } = await c.relay.listMachines(); current(gen);
        const m = machines.find((x) => x.id === setup.machineId);
        if (!m) throw new Error('that machine is no longer on this account');
        const machineKey = openMachineKey(m.dataEncryptionKey, c.contentSecret);
        const meta = await openMachineMetadata(m.metadata, machineKey); current(gen);
        const spec = { cwd: setup.cwd || DEFAULT_FOLDER, agent: 'claude', createDir: true, headless: true };
        pending = { id: crypto.randomUUID(), machineId: m.id, wire: sealSpawnSpec(spec, meta?.capabilities?.spawnSpecSealed && machineKey ? machineKey : null, m.id) };
        // Keep the exact intent AND encrypted payload before the first request.
        // A worker may die after the relay accepted it but before the reply.
        await set({ pendingSpawn: pending }, gen);
      }
      if (!pending.relayId) {
        const created = await c.relay.createSession(pending.machineId, pending.wire, pending.id); current(gen);
        const relayId = created.sessionId ?? created.session?.sessionId ?? created.id;
        if (!relayId) throw new Error('the relay did not return a session id');
        pending = { ...pending, relayId };
        await set({ pendingSpawn: pending }, gen);
        await log(`asked ${setup.machineName ?? 'the machine'} to start a session in ${setup.cwd || DEFAULT_FOLDER}`, gen);
      }
      let row = null;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await sleep(500); current(gen);
        row = ((await c.relay.listSessions()).sessions ?? []).find((s) => s.sessionId === pending.relayId) ?? null; current(gen);
        if (row?.state === 'failed') {
          const why = (await c.relay.sessionState(pending.relayId)).spawnFailure ?? 'spawn_failed'; current(gen);
          if (String(why).startsWith('dir_missing') && !pending.retried) {
            pending = { ...pending, retried: true }; await set({ pendingSpawn: pending }, gen);
            await c.relay.retrySpawn(pending.relayId); continue;
          }
          await set({ pendingSpawn: null }, gen); // definitive failure: an explicit retry may create a new intent
          throw new Error(`the machine could not start the session: ${why}`);
        }
        if (row?.localSessionId && row.sessionKeyEnvelope) break;
      }
      if (!row?.localSessionId || !row?.sessionKeyEnvelope) throw new Error('the machine has not started the session — is its daemon online? Retry to check the same session.');
      await link(row, { announce: true, gen });
    } catch (e) {
      if (gen === epoch) {
        try { await set({ linkError: e?.message ?? String(e) }, gen); await log(`could not start a session: ${e?.message ?? e}`, gen); await broadcastMeta(); } catch { /* keep the original failure */ }
      }
      throw e;
    } finally { if (spawning === job) spawning = null; }
  })();
  spawning = job;
  return job;
}

/** A definitive end starts one fresh session. Transient errors remain visible;
 *  failed spawns park until a person retries, using the persisted intent. */
let linkedJob = null;
function ensureLinked() {
  if (linkedJob?.gen === epoch) return linkedJob.promise;
  const job = { gen: epoch, promise: null };
  job.promise = refreshLink(job.gen).finally(() => { if (linkedJob === job) linkedJob = null; });
  linkedJob = job; return job.promise;
}
async function refreshLink(gen) {
  const { setup, linked, linkError } = await get(['setup', 'linked', 'linkError']); current(gen);
  if (!setup?.machineId || spawning || connectionJob) return;
  if (!linked) { if (!linkError) await startSession(); return; }
  const c = await ensureClient(); current(gen);
  if (!c) return;
  let gone = false;
  try { gone = ['archived', 'deleted', 'failed'].includes((await (await via(linked, c)).sessionState(linked.sessionId)).sessionState); }
  catch (e) { if (e?.status !== 404) throw e; gone = true; }
  current(gen);
  if (!gone || connectionJob || !sameLink(linked, (await get('linked')).linked)) return;
  current(gen);
  await log(`session ${linked.localId} has ended — starting a fresh one`, gen);
  await set({ linked: null, cursor: 0, pendingResult: null, pendingSpawn: null }, gen); stopWatching();
  await startSession();
}

// Chrome stops an idle worker; an alarm is the polling floor. Module startup
// also resumes a persisted spawn, including when no browser startup event fires.
const tick = async () => { await ensureLinked(); await ensureWatching(); };
// A browser without alarms (some WebKit ones) gets a plain interval: it lives as
// long as the background does, which in such browsers is the whole time.
if (api.alarms) {
  wire('alarms.onAlarm', () => api.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) background(tick); }));
  background(async () => { await api.alarms.create(ALARM, { periodInMinutes: 0.5 }); });
} else { startupErrors.push('alarms: not available — polling on a 30 s interval instead'); setInterval(() => background(tick), 30_000); }
wire('runtime.onStartup', () => api.runtime.onStartup.addListener(() => background(tick)));
wire('runtime.onInstalled', () => api.runtime.onInstalled.addListener(() => background(tick)));
background(tick);

// ── requests from the popup and the page button ──────────────────────────────
async function machinesView() {
  const c = await ensureClient();
  if (!c) throw new Error('pair this browser first');
  const { machines = [] } = await c.relay.listMachines();
  const out = [];
  for (const m of machines) {
    const meta = await openMachineMetadata(m.metadata, openMachineKey(m.dataEncryptionKey, c.contentSecret));
    out.push({ id: m.id, name: meta?.displayName || meta?.host || m.id.slice(0, 8), online: !!(m.active || m.leaseAlive) });
  }
  return out.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
}

const handlers = {
  async status() {
    const s = await get(['setup', 'linked', 'paused', 'excluded', 'scripts', 'linkError', 'relayError', 'log', 'draft', 'recent']);
    return {
      stage: !s.setup?.secret ? 'pair' : !s.setup?.machineId ? 'machine' : 'ready',
      relayUrl: s.setup?.relayUrl ?? null, machineName: s.setup?.machineName ?? null, cwd: s.setup?.cwd ?? null, mode: s.setup?.mode ?? 'relay',
      linked: s.linked ?? null, starting: !!spawning, linkError: s.linkError ?? s.relayError ?? null, paused: !!s.paused,
      excluded: s.excluded ?? [], scripts: (s.scripts ?? []).map(({ id, revision, name, match, code, enabled, approved }) => ({ id, revision, name, match, code, enabled, approved })),
      log: s.log ?? [], defaultFolder: DEFAULT_FOLDER, draft: s.draft ?? null, recent: s.recent ?? [],
    };
  },
  /** Step one: prove the relay and the code, keep them, and say which machines there are. */
  async login({ relayUrl, backupCode }, gen) {
    const { url, error } = relayAddress(relayUrl);
    if (error) throw new Error(error);
    await set({ draft: { relayUrl: String(relayUrl ?? '').trim() } }, gen); // so a failed try does not cost the typing
    let accountSecret;
    try { accountSecret = parseBackupCode(backupCode); } catch { throw new Error('that is not a backup code — copy it from the joy app, Settings → Account'); }
    const perimeterKey = relayPerimeterKey(accountSecret);
    const wrong = await withTimeout(describeRelay(url, { perimeterKey }), 20_000, 'relay check'); current(gen);
    if (wrong) throw new Error(wrong);
    try { await withTimeout(loginWithSecret(url, accountSecret, { perimeterKey }), 20_000, 'relay login'); current(gen); }
    catch (e) { throw new Error(e?.status === 401 || e?.status === 403 ? `${url} does not know this backup code — is it the relay this account lives on?` : `${url}: ${e?.message ?? e}`); }
    current(gen); client = null; clientJob = null;
    await set({ setup: { relayUrl: url, secret: b64(accountSecret) }, linked: null, cursor: 0, pendingSpawn: null, pendingResult: null, linkError: null, relayError: null }, gen);
    await log(`paired with ${url}`, gen);
    return { machines: await machinesView() };
  },
  machines: async () => ({ machines: await machinesView() }),
  /** Step two: the machine and folder, then the session starts by itself. */
  async start({ machineId, machineName, cwd, mode }, gen) {
    const { setup, pendingSpawn } = await get(['setup', 'pendingSpawn']);
    current(gen);
    if (!setup?.secret || !machineId) throw new Error('choose a machine after pairing');
    const folder = (cwd ?? '').trim() || DEFAULT_FOLDER;
    const pending = setup.machineId === machineId && (setup.cwd || DEFAULT_FOLDER) === folder ? pendingSpawn ?? null : null;
    await set({ setup: { ...setup, machineId, machineName, cwd: folder, mode: mode === 'direct' ? 'direct' : 'relay' }, linked: null, cursor: 0, pendingSpawn: pending, pendingResult: null }, gen);
    stopWatching();
    await startSession();
    return { ok: true };
  },
  async newSession(_msg, gen) { await set({ linked: null, cursor: 0, pendingResult: null }, gen); await startSession(); return { ok: true }; },
  /** Settings → connect to a session that already exists, by its id or a prefix. */
  async connect({ ref, direct = null, machineId = null }, gen) {
    const c = await ensureClient();
    current(gen); if (!c) throw new Error('pair this browser first');
    const want = String(ref ?? '').trim().toLowerCase();
    if (!want) throw new Error('enter a session id');
    const { setup } = await get('setup'); current(gen);
    if (direct ?? setup?.mode === 'direct') {
      // Direct: the session is looked up on the daemon, not on the relay.
      const on = machineId ?? setup?.machineId;
      const rows = (await (await directOf(c, on)).listSessions()).sessions ?? [];
      const exact = rows.filter((s) => s.id === want);
      const hits = exact.length ? exact : rows.filter((s) => String(s.id).startsWith(want));
      if (!hits.length) throw new Error(`no session on the machine matches "${want}"`);
      if (hits.length > 1) throw new Error(`${hits.length} sessions match "${want}" — use more of the id`);
      await attach(directLink(hits[0].id, on, hits[0].summary ?? null), { announce: true, gen });
      return { ok: true };
    }
    const rows = ((await c.relay.listSessions()).sessions ?? []).filter((s) => s.state !== 'deleted');
    const exact = rows.filter((s) => s.sessionId === want || s.localSessionId === want);
    const hits = exact.length ? exact : rows.filter((s) => s.sessionId.startsWith(want) || (s.localSessionId ?? '').startsWith(want));
    if (!hits.length) throw new Error(`no session matches "${want}"`);
    if (hits.length > 1) throw new Error(`${hits.length} sessions match "${want}" — use more of the id`);
    if (!hits[0].sessionKeyEnvelope && hits[0].encryptedMetadata) throw new Error('that session cannot be read with this account');
    await link(hits[0], { announce: true, gen });
    return { ok: true };
  },
  async pause({ paused }) { const gen = epoch; await set({ paused: !!paused }, gen); await log(paused ? 'paused: nothing will run' : 'resumed', gen); await broadcastMeta(); return { ok: true }; },
  async 'exclude:add'({ pattern }) {
    const p = normalizePattern(pattern);
    if (!p) throw new Error('that does not look like a site — try example.com or example.com/account/*');
    await change('excluded', ({ excluded = [] }) => ({ excluded: [...new Set([...excluded, p])].sort() }));
    return { ok: true, pattern: p };
  },
  async 'exclude:remove'({ pattern }) { await change('excluded', ({ excluded = [] }) => ({ excluded: excluded.filter((p) => p !== pattern) })); return { ok: true }; },
  async 'scripts:set'({ id, revision, approved, enabled, remove }) {
    const gen = epoch;
    let entry; let next;
    await change('scripts', ({ scripts = [] }) => {
      entry = scripts.find((s) => s.id === id);
      if (!entry) throw new Error('that saved script no longer exists');
      if (entry.revision !== revision) throw new Error('that script changed — review the new version before approving it');
      next = remove ? scripts.filter((s) => s.id !== id) : scripts.map((s) => s.id !== id ? s : { ...s, approved: approved ?? s.approved, enabled: !!(enabled ?? s.enabled) && !!(approved ?? s.approved) });
      return { scripts: next };
    });
    await log(remove ? `removed saved script "${entry.name}"` : `saved script "${entry.name}": ${next.find((x) => x.id === id)?.enabled ? 'on' : 'off'}`, gen);
    await broadcastMeta(); return { ok: true };
  },
  async clear() {
    epoch++; stopWatching(); client?.direct?.close(); client = clientJob = spawning = connectionJob = null;
    await writes(() => api.storage.local.clear()); post({ type: 'gone' }); return { ok: true };
  },
  /** The page button asks: should I be here? */
  async pageState({ url }) {
    const { setup, excluded = [], fab = null, paused = false } = await get(['setup', 'excluded', 'fab', 'paused']);
    return { show: !!setup?.machineId && !matchesAny(url, excluded), fab, paused };
  },
  /** What a person can paste when the extension misbehaves in a browser we
   *  cannot run ourselves. No secrets: only which keys exist. */
  async diagnostics() {
    const s = await get(['setup', 'linked', 'cursor', 'paused', 'excluded', 'scripts', 'linkError', 'relayError', 'pendingSpawn', 'pendingResult', 'log']);
    return {
      manifestVersion: api.runtime.getManifest?.().manifest_version ?? null, version: api.runtime.getManifest?.().version ?? null,
      direct: { mode: s.setup?.mode ?? 'relay', rtcHere: typeof globalThis.RTCPeerConnection === 'function', offscreen: !!api.offscreen, connected: !!client?.direct?.peer },
      apis: { alarms: !!api.alarms, debugger: !!api.debugger, tabsExecuteScript: typeof api.tabs?.executeScript === 'function', scripting: !!api.scripting, tabsQuery: typeof api.tabs?.query === 'function', storageOnChanged: !!api.storage?.onChanged, webCrypto: !!globalThis.crypto?.subtle, randomUUID: typeof globalThis.crypto?.randomUUID === 'function' },
      startupErrors,
      state: { paired: !!s.setup?.secret, machine: s.setup?.machineName ?? null, relay: s.setup?.relayUrl ?? null, linked: s.linked ? { localId: s.linked.localId, hasEnvelope: !!s.linked.envelope } : null, cursor: s.cursor ?? null, paused: !!s.paused, excluded: (s.excluded ?? []).length, scripts: (s.scripts ?? []).length, pendingSpawn: !!s.pendingSpawn, pendingResult: !!s.pendingResult, linkError: s.linkError ?? null, relayError: s.relayError ?? null, spawning: !!spawning, watching: !!watcher, ports: ports.size },
      log: (s.log ?? []).slice(-12),
    };
  },
  async 'fab:save'({ x, y }) { await set({ fab: { x, y } }); return { ok: true }; },
};

// A double click or two popups must share the same operation. Clear is allowed
// to interrupt it; every deferred write checks the connection generation.
let connectionJob = null;
for (const type of ['login', 'start', 'newSession', 'connect']) {
  const handle = handlers[type];
  handlers[type] = (msg = {}) => {
    const key = JSON.stringify([type, msg]);
    if (connectionJob) return connectionJob.key === key ? connectionJob.promise : Promise.reject(new Error('a connection change is already running'));
    const gen = ++epoch;
    stopWatching(); clientJob = spawning = null;
    const job = { key, promise: null };
    job.promise = Promise.resolve().then(() => handle(msg, gen)).finally(() => { if (connectionJob === job) connectionJob = null; });
    connectionJob = job;
    return job.promise;
  };
}
api.runtime.onMessage.addListener((msg, _sender, respond) => {
  const h = Object.hasOwn(handlers, msg?.type) ? handlers[msg.type] : null;
  if (!h) return false;
  Promise.resolve().then(() => h(msg)).then(respond, (e) => respond({ error: e?.message ?? String(e) })).catch(() => {}); // popup may close before the reply
  return true;
});
