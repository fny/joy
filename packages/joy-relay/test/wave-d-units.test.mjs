// Wave D (review campaign 2026-09) — unit-level reproductions for the pieces
// that need no database: notify (#81, #618) and gate CORS (#85).
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { createNotify, SSE_MAX_BUFFERED_BYTES } from '../src/notify.mjs';
import { createGate } from '../src/gate.mjs';

/** A response whose socket never drains: write() reports backpressure and
 *  the buffered byte count only grows — the slow SSE reader of #81. */
function stalledRes() {
  const res = new EventEmitter();
  res.writableLength = 0;
  res.writableNeedDrain = false;
  res.destroyed = false;
  res.writableEnded = false;
  res.writes = [];
  res.write = (frame) => { res.writes.push(frame); res.writableLength += frame.length; res.writableNeedDrain = true; return false; };
  res.destroy = () => { res.destroyed = true; res.emit('close'); };
  return res;
}

describe('notify: SSE backpressure (#81)', () => {
  it('drops replaceable ephemeral frames while the socket waits for drain', () => {
    const notify = createNotify();
    const res = stalledRes();
    notify.addSse('acct', res).markReady();
    notify.emitEphemeral('acct', 's', 't', 'delta-0'); // first one goes out and flips needDrain
    for (let i = 1; i < 100; i++) notify.emitEphemeral('acct', 's', 't', `delta-${i}`);
    expect(res.writes.length).toBe(1);
    expect(res.destroyed).toBe(false);
  });

  it('closes a client whose buffered bytes exceed the cap instead of growing without bound', () => {
    const notify = createNotify();
    const res = stalledRes();
    notify.addSse('acct', res).markReady();
    let frames = 0;
    while (!res.destroyed && frames < 100_000) { notify.pokeAccount('acct', 's'.repeat(2000), ['events']); frames++; }
    expect(res.destroyed).toBe(true);
    expect(res.writableLength).toBeLessThanOrEqual(SSE_MAX_BUFFERED_BYTES);
    expect(frames).toBeLessThan(100_000);
    // The close unregistered it: nothing else is written.
    const after = res.writes.length;
    notify.pokeAccount('acct', 's', ['events']);
    expect(res.writes.length).toBe(after);
    expect(notify.stats().sseClients).toBe(0);
  });
});

describe('notify: daemon waiter map (#618)', () => {
  it('woken and timed-out waits leave no key behind', async () => {
    const notify = createNotify();
    const waits = [];
    for (let i = 0; i < 200; i++) waits.push(notify.waitForDaemon(`daemon-${i}`, 'work', 5_000));
    for (let i = 0; i < 200; i++) notify.wakeDaemon(`daemon-${i}`, 'work');
    await Promise.all(waits);
    await notify.waitForDaemon('daemon-timeout', 'control', 1);
    expect(notify.stats().daemonWaiterKeys).toBe(0);
    // A key with a waiter still parked stays until it fires.
    const parked = notify.waitForDaemon('daemon-x', 'work', 10_000);
    expect(notify.stats().daemonWaiterKeys).toBe(1);
    notify.wakeDaemon('daemon-x', 'work');
    await parked;
    expect(notify.stats().daemonWaiterKeys).toBe(0);
  });
});

function fakeRes() {
  const res = { status: null, headers: null, body: '' };
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.end = (body) => { res.body = body ?? ''; };
  return res;
}

describe('gate: rejections carry CORS (#85)', () => {
  it('a browser client can read the 401 and its body', () => {
    const gate = createGate('perimeter-key');
    const req = { method: 'GET', url: '/joy/v2/sessions', headers: { origin: 'https://app.example' } };
    expect(gate.allows(req)).toBe(false);
    const res = fakeRes();
    gate.rejectHttp(res, req);
    expect(res.status).toBe(401);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.example');
    expect(res.headers['access-control-allow-headers']).toContain('x-joy-relay-key');
    expect(JSON.parse(res.body).error).toBe('relay key required');
    // No origin → wildcard, as the router does.
    const res2 = fakeRes();
    gate.rejectHttp(res2, { headers: {} });
    expect(res2.headers['access-control-allow-origin']).toBe('*');
    // The right key still passes.
    expect(gate.allows({ url: '/x', headers: { 'x-joy-relay-key': 'perimeter-key' } })).toBe(true);
  });
});
