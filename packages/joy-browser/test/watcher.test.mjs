import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

globalThis.self = globalThis;
const { Watcher, agentTextOf } = await import('../src/watcher.js');
const { sealV2Json, sealText, openPayload } = await import('../src/crypto.js');

const key = new Uint8Array(randomBytes(32));
const TAG = (code) => `<joy-browser-execute>\n${code}\n</joy-browser-execute>`;
const agentText = (seq, text, extra = {}) => ({ seq, kind: 'output', content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: { role: 'session', content: { type: 'session', data: { role: 'agent', ev: { t: 'text', text, ...extra } } }, meta: { sentFrom: 'joy' } } }, key) } });
const userPrompt = (seq, text) => ({ seq, kind: 'turn.queued', content: { ciphertext: sealText(text, key) } });
const mirroredUser = (seq, text) => ({ seq, kind: 'output', content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: { role: 'user', content: { type: 'text', text } } }, key) } });
const legacyPlain = (seq, text) => ({ seq, kind: 'output', content: { ciphertext: sealText(text, key) } });

function rig(events, { cursor = 0, execute } = {}) {
  const sent = []; const ran = []; const saved = [];
  const state = { sessionId: 's1', key, cursor };
  const relay = {
    events: async (_id, after) => ({ messages: events.filter((e) => e.seq > after) }),
    sendCiphertext: async (_id, ct) => { sent.push(openPayload(ct, key).text); return {}; },
    sendText: async (_id, text) => { sent.push(text); return {}; },
  };
  const store = { load: async () => ({ ...state }), saveCursor: async (n) => { saved.push(n); state.cursor = n; } };
  const w = new Watcher({ relay, store, execute: execute ?? (async (tag) => { ran.push(tag.code); return { tab: { id: 1, url: 'https://a.test/' }, value: '"ok"' }; }) });
  return { w, sent, ran, saved, state };
}

test("the agent's tag runs and the answer goes back sealed, as a browser message", async () => {
  const r = rig([agentText(1, `On it.\n\n${TAG('return document.title')}`)]);
  await r.w.poll();
  assert.deepEqual(r.ran, ['return document.title']);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /^<joy-message from="browser">\ntab 1 · https:\/\/a\.test\/\nstatus: ok\nvalue: "ok"\n<\/joy-message>$/);
});

test('only the agent speaks: prompts, mirrored user text, legacy plain and thinking never run', async () => {
  const r = rig([
    userPrompt(1, TAG('alert("from a prompt")')),
    mirroredUser(2, TAG('alert("typed in the terminal")')),
    legacyPlain(3, TAG('alert("legacy plain payload")')),
    agentText(4, TAG('alert("thinking out loud")'), { thinking: true }),
  ]);
  await r.w.poll();
  assert.deepEqual(r.ran, []);
  assert.deepEqual(r.sent, []);
  assert.equal(r.state.cursor, 4, 'they are still consumed');
});

test('its own answer cannot re-trigger it, even when a page printed a tag into the result', async () => {
  const events = [agentText(1, TAG('return 1'))];
  const r = rig(events, { execute: async () => ({ tab: null, value: TAG('alert("echo")') }) });
  await r.w.poll();
  // The relay queues the answer as a prompt — feed it back the way it arrives.
  events.push(userPrompt(2, r.sent[0]));
  await r.w.poll();
  assert.equal(r.sent.length, 1, 'one run, one answer, no loop');
});

test('history is not news: nothing at or below the cursor runs', async () => {
  const r = rig([agentText(5, TAG('return "old"')), agentText(6, TAG('return "new"'))], { cursor: 5 });
  await r.w.poll();
  assert.deepEqual(r.ran, ['return "new"']);
});

test('at most once: the cursor is saved before the script runs', async () => {
  let cursorWhenRun = null;
  const r = rig([agentText(3, TAG('return 1'))], { execute: async () => { cursorWhenRun = r.state.cursor; throw new Error('worker died mid-run'); } });
  await r.w.poll();
  assert.equal(cursorWhenRun, 3);
  assert.match(r.sent[0], /status: error\nerror: worker died mid-run/, 'a throwing executor is still answered');
  await r.w.poll();
  assert.equal(r.sent.length, 1, 'and never run a second time');
});

test('several tags in one message are answered together, in order', async () => {
  const r = rig([agentText(1, `${TAG('return "a"')}\n${TAG('return "b"')}`)]);
  await r.w.poll();
  assert.deepEqual(r.ran, ['return "a"', 'return "b"']);
  assert.equal(r.sent.length, 1);
  assert.match(r.sent[0], /\[result 1 of 2\][\s\S]*\[result 2 of 2\]/);
});

test('overlapping polls do not double-run: a poke during a poll asks for one more pass', async () => {
  const events = [agentText(1, TAG('return 1'))];
  let release; const gate = new Promise((res) => { release = res; });
  const r = rig(events, { execute: async (tag) => { await gate; return { tab: null, value: tag.code }; } });
  const first = r.w.poll();
  const second = r.w.poll(); // arrives mid-run
  events.push(agentText(2, TAG('return 2')));
  release();
  await Promise.all([first, second]);
  assert.equal(r.sent.length, 2, 'both tags answered, each exactly once');
});

test('nothing attached, nothing fetched', async () => {
  let fetched = false;
  const w = new Watcher({ relay: { events: async () => { fetched = true; return { messages: [] }; } }, store: { load: async () => null, saveCursor: async () => {} }, execute: async () => ({}) });
  await w.poll();
  assert.equal(fetched, false);
});

test('agentTextOf refuses what it cannot open', () => {
  assert.equal(agentTextOf({ seq: 1, kind: 'output', content: { ciphertext: sealText('x', key) } }, new Uint8Array(32)), null);
  assert.equal(agentTextOf({ seq: 1 }, key), null);
});

test('a remember tag is saved, not run, and answered in order with what did run', async () => {
  const remembered = [];
  const events = [agentText(1, `<joy-browser-remember name="Tidy" match="a.test">\ndocument.title = "x";\n</joy-browser-remember>\n${TAG('return 1')}`)];
  const sent = []; const ran = [];
  const state = { sessionId: 's1', key, cursor: 0 };
  const w = new Watcher({
    relay: { events: async (_i, after) => ({ messages: events.filter((e) => e.seq > after) }), sendText: async (_i, text) => { sent.push(text); } },
    store: { load: async () => ({ ...state }), saveCursor: async (n) => { state.cursor = n; } },
    execute: async (tag) => { ran.push(tag.code); return { tab: null, value: '1' }; },
    remember: async (tag) => { remembered.push(tag.attrs.name); return { note: `saved "${tag.attrs.name}" — waiting for the user to approve it` }; },
  });
  await w.poll();
  assert.deepEqual(remembered, ['Tidy']);
  assert.deepEqual(ran, ['return 1'], 'the remembered script itself never ran');
  assert.match(sent[0], /\[result 1 of 2\] saved "Tidy" — waiting for the user to approve it\n\n\[result 2 of 2\] no tab\nstatus: ok/);
});

test('the chat sees new events before anything in them runs, and only once', async () => {
  const seen = []; const order = [];
  const events = [agentText(1, TAG('return 1')), agentText(2, 'plain words')];
  const state = { sessionId: 's1', key, cursor: 0 };
  const w = new Watcher({
    relay: { events: async (_i, after) => ({ messages: events.filter((e) => e.seq > after) }), sendText: async () => {} },
    store: { load: async () => ({ ...state }), saveCursor: async (n) => { state.cursor = n; } },
    execute: async () => { order.push('ran'); return { tab: null, value: '1' }; },
    onEvents: (evs) => { order.push('seen'); seen.push(...evs.map((e) => e.seq)); },
  });
  await w.poll(); await w.poll();
  assert.deepEqual(seen, [1, 2]);
  assert.deepEqual(order.slice(0, 2), ['seen', 'ran']);
});

test('unordered pages execute each script in sequence without skipping one', async () => {
  const r = rig([agentText(3, TAG('third')), agentText(1, TAG('first')), agentText(2, TAG('second'))]);
  await r.w.poll();
  assert.deepEqual(r.ran, ['first', 'second', 'third']);
  assert.deepEqual(r.saved, [1, 2, 3]);
});

test('nonadvancing or invalid pages fail instead of spinning or losing the cursor', async () => {
  for (const events of [[{ seq: 0 }], [{ seq: 'bad' }], [{ seq: 1 }]]) {
    const w = new Watcher({ relay: { events: async () => ({ messages: events }) }, store: { load: async () => ({ sessionId: 's', cursor: 1 }), saveCursor: () => assert.fail('no cursor write') } });
    await assert.rejects(w.poll(), /invalid event sequence|did not advance/);
  }
});

test('stopping an in-flight poll prevents its cursor write and script execution', async () => {
  let deliver; const page = new Promise((r) => { deliver = r; });
  const r = rig([]); r.w.relay.events = () => page;
  const poll = r.w.poll(); await Promise.resolve();
  r.w.stop(); deliver({ messages: [agentText(1, TAG('old session'))] });
  await poll; await r.w.poll();
  assert.deepEqual(r.saved, []); assert.deepEqual(r.ran, []);
});

test('a lost cursor claim prevents execution, even when a relink races storage', async () => {
  const r = rig([agentText(1, TAG('old session'))]);
  r.w.store.saveCursor = async () => false;
  await r.w.poll(); assert.deepEqual(r.ran, []);
});

test('rejected async view and log callbacks do not interrupt execution', async () => {
  const r = rig([agentText(1, TAG('return 1'))]);
  r.w.onEvents = async () => { throw Error('closed view'); };
  r.w.log = async () => { throw Error('full storage'); };
  await r.w.poll(); assert.equal(r.sent.length, 1);
});

test('an undelivered result survives restart, with the same intent and no second execution', async () => {
  const r = rig([agentText(1, TAG('click once'))]);
  r.w.store.saveResult = async (p) => { r.state.pendingResult = p; };
  r.w.store.clearResult = async () => { r.state.pendingResult = null; };
  const attempts = [];
  r.w.relay.sendText = async (_id, text, _key, intent) => { attempts.push({ text, intent }); if (attempts.length === 1) throw Error('reply lost'); };
  await assert.rejects(r.w.poll(), /reply lost/);
  const restarted = new Watcher({ relay: r.w.relay, store: r.w.store, execute: () => assert.fail('replayed a script') });
  await restarted.poll();
  assert.deepEqual(attempts[0], attempts[1]); assert.ok(attempts[0].intent);
  assert.deepEqual(r.ran, ['click once']); assert.equal(r.state.pendingResult, null);
});

test('malformed or non-agent records never execute', () => {
  for (const record of [null, {}, { role: 'tool', content: { data: { ev: { t: 'text', text: TAG('bad') } } } }]) {
    assert.equal(agentTextOf({ kind: 'output', content: { ciphertext: sealV2Json({ v: 1, t: 'record', record }, key) } }, key), null);
  }
});

// The record the daemon REALLY writes (verbatim from session c9dd2294, 2026-09-18).
// The test helpers used to fake a flatter shape; the watcher matched the fake and
// silently ignored every real tag while the panel, a looser reader, showed them.
test('the daemon\'s own wrapper is read: role session, data.role agent', () => {
  const real = { role: 'session', content: { type: 'session', data: { id: 'b656817f-fd42-45cc-91ec-f1cbbbc03191', time: 1789747893910, role: 'agent', turn: '2e936769-a050-43fe-b077-b0d00df92b5f', ev: { t: 'text', text: "<joy-browser-execute>\nconsole.log('hello from Claude');\n'logged: ' + document.title;\n</joy-browser-execute>" }, claudeUuid: 'b656817f-fd42-45cc-91ec-f1cbbbc03191' } }, meta: { sentFrom: 'joy' } };
  const ev = { seq: 33, kind: 'output', content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: real }, key) } };
  assert.match(agentTextOf(ev, key), /^<joy-browser-execute>/);
  // the flat shape stays accepted; a user's text and an agent thought do not
  const flat = { ...ev, content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: { role: 'agent', content: { type: 'event', data: { ev: { t: 'text', text: 'flat' } } } } }, key) } };
  assert.equal(agentTextOf(flat, key), 'flat');
  const user = { ...ev, content: { ciphertext: sealV2Json({ v: 1, t: 'record', record: { role: 'session', content: { type: 'session', data: { role: 'user', ev: { t: 'text', text: 'not me' } } } } }, key) } };
  assert.equal(agentTextOf(user, key), null);
});

test('a result saved sealed by an older version is still delivered as it was', async () => {
  const r = rig([]);
  r.state.pendingResult = { id: 'old', ciphertext: sealText('status: ok', key) };
  const got = [];
  r.w.relay.sendCiphertext = async (_id, ct, intent) => { got.push([openPayload(ct, key).text, intent]); };
  r.w.store.clearResult = async () => { r.state.pendingResult = null; };
  await r.w.poll();
  assert.deepEqual(got, [['status: ok', 'old']]);
});

test('Direct mode: events carry their payload open, and a tag in one runs', async () => {
  const direct = (seq, record) => ({ seq, payload: { t: 'record', record } });
  const agent = { role: 'session', content: { type: 'session', data: { role: 'agent', ev: { t: 'text', text: TAG('direct') } } } };
  assert.equal(agentTextOf(direct(1, agent), null), TAG('direct'));
  assert.equal(agentTextOf(direct(2, { role: 'user', content: { type: 'text', text: TAG('echo') } }), null), null);
  const r = rig([direct(1, agent)]);
  await r.w.poll();
  assert.deepEqual(r.ran, ['direct']);
});
