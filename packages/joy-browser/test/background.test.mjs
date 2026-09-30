import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { serial, sameLink, boundedRelay } from '../src/state.js';
import { matchesAny, normalizePattern } from '../src/patterns.js';
import { browserMessage, splitMatch } from '../src/tags.js';

const source = readFileSync(new URL('../background.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '');
const gate = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const event = () => { const listeners = new Set(); return { listeners, addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f), fire: (...a) => [...listeners].map((f) => f(...a)) }; };
const flush = () => new Promise((r) => setImmediate(r));
const clone = (x) => structuredClone(x);
const setup = { relayUrl: 'https://relay.test', secret: 'opaque', machineId: 'm', machineName: 'machine' };
const linked = { sessionId: 's', token: 'link-1', envelope: 'opaque', localId: 'abcd' };

// Run the actual module; mock browser APIs and crypto only at its imports.
// Crypto stays opaque, and no credential or real network is needed here.
async function rig(initial = {}, overrides = {}) {
  const data = clone(initial);
  const local = {
    async get(keys) { await Promise.resolve(); return clone(Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(patch) { await Promise.resolve(); Object.assign(data, clone(patch)); },
    async clear() { for (const k of Object.keys(data)) delete data[k]; },
  };
  const api = { storage: { local }, tabs: { onUpdated: event(), onRemoved: event(), get: async (id) => ({ id, url: 'https://site.test', status: 'complete' }), query: async () => [], create: async () => ({ id: 1 }) }, runtime: { onConnect: event(), onStartup: event(), onInstalled: event(), onMessage: event() }, alarms: { create: async () => {}, onAlarm: event() } };
  const relay = {
    listMachines: async () => ({ machines: [{ id: 'm' }] }),
    listSessions: async () => ({ sessions: [{ sessionId: 'new', localSessionId: 'fresh', sessionKeyEnvelope: 'opaque', headSeq: 1 }] }),
    createSession: async () => ({ sessionId: 'new' }),
    sessionState: async () => ({ headSeq: 8, execution: 'idle', sessionState: 'active' }),
    eventsBefore: async () => ({ messages: [] }), events: async () => ({ messages: [] }),
    stream: () => () => {}, sendCiphertext: async () => {}, sendText: async () => {}, ...overrides.relay,
  };
  const watchers = [];
  class FakeWatcher { constructor(options) { Object.assign(this, options); watchers.push(this); } stop() { this.stopped = true; } async poll() {} }
  const context = vm.createContext({
    api, crypto: webcrypto, URL, console, Date, Promise, serial, sameLink, boundedRelay, matchesAny, normalizePattern, browserMessage, splitMatch,
    Watcher: FakeWatcher, RelayClient: class { constructor() { return relay; } },
    loginWithSecret: overrides.login ?? (async () => 'token'), parseBackupCode: () => 'secret', b64: () => 'secret', unb64: () => 'secret',
    relayPerimeterKey: () => 'opaque', contentKeyPair: () => ({ secretKey: 'opaque' }), openSessionKeyEnvelope: () => 'key', openCard: () => null, openMachineKey: () => 'key', openMachineMetadata: async () => ({}), sealSpawnSpec: () => 'sealed-random-payload', sealText: (t) => t,
    relayAddress: () => ({ url: 'https://relay.test' }), describeRelay: async () => null,
    foldEvents: (events, _key, working) => ({ rows: events.filter((x) => x.row).map((x) => x.row), working: events.some((x) => x.kind === 'turn.terminal') ? false : working }),
    runInTab: overrides.run ?? (async () => ({ value: 'ok' })), tabInfo: (t) => t,
    withTimeout: async (p) => p,
    setTimeout: (fn) => { Promise.resolve().then(fn); return 0; }, clearTimeout: () => {},
  });
  vm.runInContext(source + '\nglobalThis.h = { handlers, store, ensureClient, ensureWatching, ensureLinked, loadConversation, startSession, execute, remember, runSavedScripts, waitForLoad, queued, log, getConvo: () => convo, ports };', context);
  await flush();
  return { ...context.h, data, api, relay, watchers };
}

test('concurrent popup/content updates preserve exclusions, scripts, and log entries', async () => {
  const r = await rig();
  await Promise.all(['a.test', 'b.test', 'c.test'].map((pattern) => r.handlers['exclude:add']({ pattern })));
  assert.deepEqual(r.data.excluded, ['a.test', 'b.test', 'c.test']);
  await Promise.all(['first', 'second'].map((name) => r.remember({ attrs: { name, match: 'a.test' }, code: 'return 1' })));
  assert.deepEqual(r.data.scripts.map((s) => s.name).sort(), ['first', 'second']);
  await Promise.all(['first', 'second'].map((line) => r.log(line)));
  assert.equal(r.data.log.length, 2);
});

test('a stale panel cannot approve replacement code with the same script id', async () => {
  const r = await rig();
  await r.remember({ attrs: { name: 'x', match: 'a.test' }, code: 'old' });
  const old = clone(r.data.scripts[0]);
  await r.remember({ attrs: { name: 'x', match: 'a.test' }, code: 'new' });
  await assert.rejects(r.handlers['scripts:set']({ id: old.id, revision: old.revision, approved: true, enabled: true }), /changed/);
  assert.equal(r.data.scripts[0].approved, false);
});

test('a previous link cannot advance a new cursor or overwrite its pending result', async () => {
  const r = await rig({ linked, cursor: 5 }); const old = { ...linked, token: 'older' };
  assert.equal(await r.store.saveCursor(999, old), false);
  assert.equal(await r.store.saveResult({ id: 'old' }, old), false);
  assert.equal(r.data.cursor, 5); assert.equal(await r.store.saveCursor(6, linked), true);
});

test('simultaneous client loads perform one login; clearing prevents late resurrection', async () => {
  const login = gate(); let calls = 0;
  const r = await rig({}, { login: () => { calls++; return login.promise; } }); r.data.setup = setup;
  const all = Promise.allSettled([r.ensureClient(), r.ensureClient()]); await flush();
  assert.equal(calls, 1);
  await r.handlers.clear(); login.resolve('token');
  assert.ok((await all).every((x) => x.status === 'rejected'));
  assert.deepEqual(r.data, {}); assert.equal(await r.ensureClient(), null);
});

test('failure of the first spawn storage write releases starting', async () => {
  const r = await rig(); r.data.setup = setup;
  const set = r.api.storage.local.set; let first = true;
  r.api.storage.local.set = async (p) => { if (first) { first = false; throw Error('storage full'); } return set(p); };
  await assert.rejects(r.startSession(), /storage full/);
  assert.equal((await r.handlers.status()).starting, false);
});

test('a lost spawn response survives worker restart without creating another intent', async () => {
  const accepted = [];
  const r = await rig({}, { relay: { createSession: async (...a) => { accepted.push(a); throw Error('lost response'); } } }); r.data.setup = setup;
  await assert.rejects(r.startSession(), /lost response/);
  assert.ok(r.data.pendingSpawn.id); assert.equal(r.data.pendingSpawn.wire, accepted[0][1]);
  const restarted = await rig(r.data, { relay: { createSession: async (...a) => { accepted.push(a); return { sessionId: 'new' }; } } });
  await Promise.all([restarted.handlers.newSession(), restarted.handlers.newSession()]);
  assert.deepEqual(accepted[1], accepted[0]); assert.equal(accepted.length, 2);
  assert.equal(restarted.data.cursor, 8, 'fresh head, not list head 1');
  assert.equal(restarted.data.pendingSpawn, null); assert.equal(restarted.data.linked.sessionId, 'new');
});

test('a spawn response arriving after clear cannot rewrite setup or link', async () => {
  const reply = gate(); const entered = gate();
  const r = await rig({}, { relay: { createSession: () => { entered.resolve(); return reply.promise; } } }); r.data.setup = setup;
  const rejected = assert.rejects(r.startSession(), /connection changed/);
  await entered.promise; await r.handlers.clear(); reply.resolve({ sessionId: 'new' }); await rejected;
  assert.deepEqual(r.data, {});
});

test('a conversation response from the old link cannot repopulate a cleared panel', async () => {
  const page = gate(); const entered = gate();
  const r = await rig({}, { relay: { eventsBefore: () => { entered.resolve(); return page.promise; } } }); Object.assign(r.data, { setup, linked });
  const rejected = assert.rejects(r.loadConversation(), /connection changed/);
  await entered.promise; await r.handlers.clear(); page.resolve({ messages: [{ seq: 1, row: { seq: 1, text: 'old' } }] }); await rejected;
  assert.equal(r.getConvo().sessionId, null); assert.equal(r.getConvo().rows.size, 0);
});

test('events arriving during initial history load are folded after the snapshot', async () => {
  const page = gate(); const entered = gate();
  const r = await rig({}, { relay: { eventsBefore: () => { entered.resolve(); return page.promise; } } }); Object.assign(r.data, { setup, linked });
  await r.ensureWatching(); const loading = r.loadConversation(); await entered.promise;
  r.watchers[0].onEvents([{ seq: 9, row: { seq: 9, text: 'new' } }, { seq: 10, kind: 'turn.terminal' }], 'key');
  page.resolve({ messages: [{ seq: 8, row: { seq: 8, text: 'history' } }] }); await loading;
  assert.deepEqual([...r.getConvo().rows.keys()], [8, 9]); assert.equal(r.getConvo().lastSeq, 10); assert.equal(r.getConvo().working, false);
});

test('pause is rechecked when a queued execution actually starts', async () => {
  let ran = 0; const gateRun = gate();
  const r = await rig({}, { run: async () => { ran++; return {}; } });
  const block = r.queued(() => gateRun.promise); const exec = r.execute({ attrs: { tab: '1' }, code: 'return 1' });
  await flush(); await r.handlers.pause({ paused: true }); gateRun.resolve(); await block;
  assert.match((await exec).error, /paused/); assert.equal(ran, 0);
});

test('a queued saved script loses permission when replaced before its turn', async () => {
  let ran = 0; const gateRun = gate();
  const r = await rig({ scripts: [{ id: 'x', revision: 'old', name: 'x', code: 'old', match: ['site.test'], approved: true, enabled: true }] }, { run: async () => { ran++; return {}; } });
  const block = r.queued(() => gateRun.promise); const run = r.runSavedScripts({ id: 1, url: 'https://site.test' }); await flush();
  await r.remember({ attrs: { name: 'x', match: 'site.test' }, code: 'new' });
  gateRun.resolve(); await block; await run; assert.equal(ran, 0);
});

test('failed tab lookup removes both page-load listeners', async () => {
  const r = await rig(); r.api.tabs.get = async () => { throw Error('no tab'); };
  const before = r.api.tabs.onUpdated.listeners.size;
  await assert.rejects(r.waitForLoad(1), /no tab/);
  assert.equal(r.api.tabs.onUpdated.listeners.size, before); assert.equal(r.api.tabs.onRemoved.listeners.size, 0);
});

test('retrying setup after a lost response keeps the original spawn intent', async () => {
  const attempts = []; let fail = true;
  const r = await rig({}, { relay: { createSession: async (...args) => { attempts.push(args); if (fail) throw Error('lost response'); return { sessionId: 'new' }; } } }); r.data.setup = { ...setup, machineId: null };
  const command = { machineId: 'm', machineName: 'machine', cwd: '~/work' };
  await assert.rejects(r.handlers.start(command), /lost response/); fail = false;
  await r.handlers.start(command);
  assert.deepEqual(attempts[0], attempts[1]);
});

test('an exclusion added while tabs are being read also hides their metadata', async () => {
  const reply = gate(); const entered = gate(); const r = await rig();
  r.api.tabs.query = () => { entered.resolve(); return reply.promise; };
  const result = r.execute({ attrs: { tab: 'list' }, code: '' }); await entered.promise;
  await r.handlers['exclude:add']({ pattern: 'site.test' }); reply.resolve([{ id: 1, url: 'https://site.test' }]);
  assert.equal((await result).tabs.length, 0);
});

test('failed automatic relink checks are shown by the alarm instead of swallowed', async () => {
  const r = await rig({}, { relay: { sessionState: async () => { throw Error('relay offline'); } } }); Object.assign(r.data, { setup, linked });
  r.api.alarms.onAlarm.fire({ name: 'joy-browser-poll' }); await flush();
  assert.equal((await r.handlers.status()).linkError, 'relay offline');
});

test('clear wins even if a settings write was already inside the storage API', async () => {
  const writing = gate(); const release = gate(); const r = await rig();
  const set = r.api.storage.local.set;
  r.api.storage.local.set = async (patch) => { if ('paused' in patch) { writing.resolve(); await release.promise; } return set(patch); };
  const pause = assert.rejects(r.handlers.pause({ paused: true }), /connection changed/);
  await writing.promise; const clear = r.handlers.clear(); release.resolve(); await clear; await pause;
  assert.deepEqual(r.data, {}, 'no late diagnostic write resurrects cleared data');
});

test('every link is remembered, newest first and without repeats, so Settings can offer it back', async () => {
  const sessions = [{ sessionId: 's', localSessionId: 'abcd', sessionKeyEnvelope: 'opaque' }, { sessionId: 'new', localSessionId: 'fresh', sessionKeyEnvelope: 'opaque' }];
  const r = await rig({ setup }, { relay: { listSessions: async () => ({ sessions }) } });
  await r.handlers.connect({ ref: 'abcd' });
  await r.handlers.connect({ ref: 'fresh' });
  await r.handlers.connect({ ref: 'abcd' });
  assert.deepEqual(r.data.recent.map((x) => x.sessionId), ['s', 'new']);
  assert.equal(r.data.recent[0].localId, 'abcd'); assert.equal(r.data.recent[0].machine, 'machine'); assert.ok(r.data.recent[0].at > 0);
  assert.deepEqual((await r.handlers.status()).recent.map((x) => x.sessionId), ['s', 'new']);
});
