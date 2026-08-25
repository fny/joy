#!/usr/bin/env node
// Scripted daemon lane for the v2 e2e suite: speaks the /joy/v2 daemon
// surface exactly the way the real daemon will once its nucleus lane ships —
// lease acquire/renew, work+control claims, bind, receipt/submit/start,
// ephemeral streaming facts, durable output, terminal. Deterministic modes
// let the suite force cases the real daemon can't produce on demand.
//
//   node v2-actor.mjs --relay http://127.0.0.1:3105 --token <bearer> \
//     --machine v2-e2e-machine [--mode normal|die-after-start|slow]
//
//   normal          echo turns: 3 ephemeral deltas + durable block + completed
//   die-after-start exits right after turn.start (lease expiry orphans the turn)
//   slow            holds the turn ~45s, honouring cancellation via the control lane
import { randomUUID } from 'node:crypto';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const RELAY = arg('relay', 'http://127.0.0.1:3105');
const TOKEN = arg('token');
const MACHINE = arg('machine', 'v2-e2e-machine');
const MODE = arg('mode', 'normal');
if (!TOKEN) { console.error('need --token'); process.exit(2); }

const log = (...a) => console.log(`[actor ${MACHINE}]`, ...a);
const decode = (ct) => { try { const p = JSON.parse(ct); return p.text ?? ct; } catch { return ct; } };
const encode = (text) => JSON.stringify({ v: 1, t: 'plain', text });

let lease = null;
async function api(method, path, { body, leaseHeaders } = {}) {
  const res = await fetch(`${RELAY}/joy/v2${path}`, {
    method,
    headers: {
      ...(leaseHeaders ? {
        'x-joy-lease-id': lease.leaseId, 'x-joy-lease-token': lease.leaseToken, 'x-joy-lease-epoch': lease.epoch,
      } : { 'Authorization': `Bearer ${TOKEN}` }),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function claim(lane, waitMs = 20_000) {
  const res = await fetch(`${RELAY}/joy/v2/daemon/leases/${lease.leaseId}/claims/${lane}`, {
    method: 'POST',
    headers: { 'x-joy-lease-token': lease.leaseToken, 'content-type': 'application/json' },
    body: JSON.stringify({ waitMs }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`claim ${lane} -> ${res.status} ${JSON.stringify(json)}`);
  return json.offers ?? [];
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runTurn(offer) {
  const H = { leaseHeaders: true };
  await api('POST', `/daemon/deliveries/${offer.deliveryId}/received`, H);
  await api('POST', `/daemon/turns/${offer.turnId}/submitted`, H);
  await api('POST', `/daemon/turns/${offer.turnId}/start`, { ...H, body: { runtimeEventId: randomUUID() } });
  log(`turn ${offer.turnId.slice(0, 8)} started (${MODE})`);

  if (MODE === 'die-after-start') {
    log('dying after start — lease expiry will orphan the turn');
    process.exit(0);
  }

  const prompt = decode(offer.ciphertext);
  if (MODE === 'slow') {
    // Hold the turn, watching the control lane for a cancellation.
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const cancels = await claim('control', 3_000);
      const mine = cancels.find(c => c.targetTurnId === offer.turnId);
      if (mine) {
        await api('POST', `/daemon/deliveries/${mine.deliveryId}/received`, H);
        await api('POST', `/daemon/turns/${offer.turnId}/facts`, { ...H, body: { type: 'terminal', terminalState: 'cancelled', runtimeEventId: randomUUID() } });
        log('turn cancelled via control lane');
        return;
      }
    }
    await api('POST', `/daemon/turns/${offer.turnId}/facts`, { ...H, body: { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() } });
    return;
  }

  // normal: streamed deltas (ephemeral, never persisted) then the durable block.
  for (const piece of ['thinking… ', 'still thinking… ', 'done. ']) {
    await api('POST', `/daemon/turns/${offer.turnId}/facts`, { ...H, body: { type: 'output', ephemeral: true, ciphertext: encode(piece) } });
    await sleep(400);
  }
  await api('POST', `/daemon/turns/${offer.turnId}/facts`, { ...H, body: { type: 'output', ciphertext: encode(`echo: ${prompt}`), runtimeEventId: randomUUID() } });
  await api('POST', `/daemon/turns/${offer.turnId}/facts`, { ...H, body: { type: 'terminal', terminalState: 'completed', runtimeEventId: randomUUID() } });
  log(`turn ${offer.turnId.slice(0, 8)} completed`);
}

async function main() {
  lease = await api('POST', '/daemon/leases', { body: { machineId: MACHINE } });
  log(`lease ${lease.leaseId.slice(0, 8)} epoch ${lease.epoch}`);
  const renew = setInterval(async () => {
    try {
      await fetch(`${RELAY}/joy/v2/daemon/leases/${lease.leaseId}`, {
        method: 'PUT', headers: { 'x-joy-lease-token': lease.leaseToken },
      });
    } catch { /* transient */ }
  }, 8_000);
  renew.unref?.();

  for (;;) {
    let offers;
    try {
      offers = await claim('work');
    } catch (e) {
      // A newer actor generation acquired a lease for this machine — the old
      // process MUST stand down (same rule the real daemon follows).
      if (/lease_unknown|lease_expired|lease_epoch_stale/.test(String(e))) {
        log('lease superseded — standing down');
        process.exit(0);
      }
      throw e;
    }
    for (const offer of offers) {
      if (offer.kind === 'spawn_session') {
        await api('POST', `/daemon/deliveries/${offer.deliveryId}/received`, { leaseHeaders: true });
        await api('POST', `/daemon/sessions/${offer.sessionId}/bind`, {
          leaseHeaders: true,
          body: { spawnCommandId: offer.commandId, localSessionId: randomUUID().slice(0, 8), sessionKeyEnvelope: 'e2e-envelope' },
        });
        log(`bound session ${offer.sessionId.slice(0, 8)}`);
      } else if (offer.kind === 'prompt') {
        await runTurn(offer);
      }
    }
  }
}

main().catch((e) => { console.error('[actor] fatal:', e.message); process.exit(1); });
