import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

globalThis.self = globalThis;
const { sealRequest, openResponse, tunnelKeyFor, tunnelJson } = await import('../src/tunnel.js');
const { DirectClient } = await import('../src/direct.js');
const { secretbox, hmac512, utf8, fromUtf8, b64, unb64 } = await import('../src/crypto.js');

// ── the tunnel: the daemon's half, written out, so both halves are checked ──
function daemonOpen(key, wire) {
  const k = hmac512(key, new Uint8Array([...utf8('stream'), ...wire.subarray(0, 16)])).slice(0, 32);
  const nacl = globalThis.nacl;
  const chunks = []; let at = 16; let i = 0;
  while (at < wire.length) {
    const len = new DataView(wire.buffer, wire.byteOffset).getUint32(at);
    const n = new Uint8Array(24); new DataView(n.buffer).setBigUint64(16, BigInt(i++));
    chunks.push(nacl.secretbox.open(wire.subarray(at + 4, at + 4 + len), n, k).subarray(1));
    at += 4 + len;
  }
  return { head: JSON.parse(fromUtf8(chunks[0])), body: fromUtf8(chunks.slice(1).reduce((a, c) => new Uint8Array([...a, ...c]), new Uint8Array())) };
}
function daemonAnswer(key, head, body) {
  const streamId = new Uint8Array(randomBytes(16));
  const k = hmac512(key, new Uint8Array([...utf8('stream'), ...streamId])).slice(0, 32);
  const frames = [utf8(JSON.stringify(head)), utf8(body)].map((c, i) => {
    const n = new Uint8Array(24); new DataView(n.buffer).setBigUint64(16, BigInt(i));
    const ct = secretbox(new Uint8Array([i === 1 ? 1 : 0, ...c]), n, k);
    const len = new Uint8Array(4); new DataView(len.buffer).setUint32(0, ct.length);
    return [len, ct];
  }).flat();
  return new Uint8Array([...streamId, ...frames.flatMap((f) => [...f])]);
}

const machineKey = new Uint8Array(randomBytes(32));
const key = tunnelKeyFor(machineKey, 'm1');

test('tunnel: a sealed request opens on the daemon side with its head and body', () => {
  const { wire, binding } = sealRequest(key, { m: 'POST', p: '/v2/rtc/connect', h: {} }, utf8('{"sdp":"x"}'));
  const got = daemonOpen(key, wire);
  assert.deepEqual(got.head, { m: 'POST', p: '/v2/rtc/connect', h: {} });
  assert.equal(got.body, '{"sdp":"x"}');
  assert.equal(binding.length, 32);
});

test('tunnel: the answer must be bound to our request, whole, and under our key', () => {
  const { binding } = sealRequest(key, { m: 'GET', p: '/', h: {} });
  const ok = daemonAnswer(key, { s: 200, h: {}, r: binding }, '{"sdp":"y"}');
  assert.equal(fromUtf8(openResponse(key, ok, binding).body), '{"sdp":"y"}');
  assert.throws(() => openResponse(key, daemonAnswer(key, { s: 200, h: {}, r: 'ff'.repeat(16) }, '{}'), binding), /another request/);
  assert.throws(() => openResponse(key, ok.subarray(0, ok.length - 3), binding), /truncated|cut off/);
  assert.throws(() => openResponse(tunnelKeyFor(machineKey, 'm2'), ok, binding), /authentication/);
});

test('tunnel: a relay refusal is not read as the daemon\'s answer', async () => {
  const post = async () => ({ status: 503, contentType: 'application/json', bytes: utf8('{"error":"daemon_offline"}') });
  await assert.rejects(tunnelJson(post, key, 'POST', '/v2/rtc/connect', {}), /offline/);
});

// ── DirectClient over a scripted channel ──
function fakeDaemon(routes) {
  const sent = [];
  return {
    sent,
    open: async ({ signal, onMessage }) => {
      assert.equal(await signal('offer-sdp'), 'answer-sdp');
      return {
        close() {},
        send(text) {
          const f = JSON.parse(text); sent.push(f);
          if (f.t !== 'req') return;
          const out = routes(f.m, f.p, f.b ? JSON.parse(fromUtf8(unb64(f.b))) : undefined);
          queueMicrotask(() => {
            onMessage(JSON.stringify({ t: 'head', id: f.id, s: out.s ?? 200, h: {} }));
            onMessage(JSON.stringify({ t: 'data', id: f.id, b: b64(utf8(out.body)) }));
            onMessage(JSON.stringify({ t: 'end', id: f.id }));
          });
        },
      };
    },
  };
}
const relay = { postTunnel: async (_m, wire) => {
  daemonOpen(key, wire); // the request must open on the daemon side
  return { status: 200, contentType: 'application/octet-stream', bytes: daemonAnswer(key, { s: 200, h: {}, r: b64Hex(wire) }, JSON.stringify({ sdp: 'answer-sdp' })) };
} };
const b64Hex = (wire) => [...wire.subarray(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
const nd = (...lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

test('Direct: the relay-shaped calls map onto the daemon API, and events come back open', async () => {
  const d = fakeDaemon((m, p, body) => {
    if (m === 'GET' && p === '/sessions/s1/check') return { body: '{"state":"busy"}' };
    if (m === 'GET' && p.startsWith('/sessions/s1/events?after=9007199254740991')) return { body: nd({ hello: true, seq: 7 }) };
    if (m === 'GET' && p === '/sessions/s1/events?after=5') return { body: nd({ hello: true, seq: 7 }, { seq: 6, at: 1, record: { role: 'user', content: { text: 'hi' } } }, { seq: 7, at: 2, record: { role: 'agent' } }) };
    if (m === 'GET' && p === '/sessions/s1/events?last=2') return { body: nd({ hello: true, seq: 7 }, { seq: 6, record: { a: 6 } }, { seq: 7, record: { a: 7 } }) };
    if (m === 'POST' && p === '/send') return { body: JSON.stringify({ ok: true, echo: body }) };
    if (m === 'POST' && p === '/sessions') return { s: 201, body: JSON.stringify({ id: 'abcd1234', spec: body }) };
    if (m === 'GET' && p === '/sessions/gone/check') return { s: 404, body: '{"error":"session_not_found"}' };
    return { s: 404, body: '{"error":"not_found"}' };
  });
  const c = new DirectClient({ relay, machineId: 'm1', machineKey, openPeer: d.open });
  assert.deepEqual(await c.sessionState('s1'), { headSeq: 7, execution: { state: 'running' }, sessionState: 'active' });
  assert.deepEqual((await c.events('s1', 5)).messages, [{ seq: 6, payload: { t: 'record', record: { role: 'user', content: { text: 'hi' } } } }, { seq: 7, payload: { t: 'record', record: { role: 'agent' } } }]);
  assert.deepEqual((await c.eventsBefore('s1', 7, 2)).messages.map((e) => e.seq), [6]);
  assert.deepEqual((await c.sendText('s1', 'hello', null, 'intent')).echo, { session_id: 's1', text: 'hello' });
  assert.deepEqual((await c.createSession({ cwd: '~/x', headless: true })).spec, { cwd: '~/x', headless: true, localOnly: true });
  await assert.rejects(c.sessionState('gone'), (e) => e.status === 404);
});

test('Direct: a closed channel fails what is in flight, and the next call connects again', async () => {
  let opens = 0; let hang = null; let closer = null;
  const open = async ({ onClose }) => {
    opens++; closer = onClose;
    return { close() {}, send(text) { hang = JSON.parse(text); } };
  };
  const c = new DirectClient({ relay, machineId: 'm1', machineKey, openPeer: open });
  const inflight = c.request('GET', '/sessions');
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(hang.p, '/sessions');
  closer('the direct connection closed');
  await assert.rejects(inflight, /closed/);
  void c.request('GET', '/sessions').catch(() => {});
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(opens, 2);
});
