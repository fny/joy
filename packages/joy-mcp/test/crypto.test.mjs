// The wire formats, against the shapes the app and daemons produce: the key
// tree, the content keypair, envelopes, sealed payloads, machine metadata,
// and a full tunnel round trip with a daemon-side opener.
import { describe, it, expect } from 'vitest';
import { randomBytes, createHmac } from 'node:crypto';
import nacl from 'tweetnacl';
import {
  deriveKey, contentKeyPair, signKeyPair, parseBackupCode, relayPerimeterKey,
  sealSessionKeyEnvelope, openSessionKeyEnvelope, sealMachineKey, openMachineKey,
  sealText, openPayload, sealCard, openCard, sealSpawnSpec, openV2Json,
  sealMachineMetadata, openMachineMetadata,
  deriveTunnelKey, sealTunnelRequest, openTunnelRequest, sealTunnelResponse, openTunnelResponse, TunnelError,
  b64, utf8, fromUtf8,
} from '../src/crypto.mjs';

const secret = new Uint8Array(randomBytes(32));

describe('key tree', () => {
  it('matches the app\'s deriveKey: HMAC-SHA512 root over "<usage> Master Seed", then 0x00-prefixed children', () => {
    const root = createHmac('sha512', Buffer.from('Joy Content Master Seed')).update(Buffer.from(secret)).digest();
    const child = createHmac('sha512', root.subarray(32)).update(Buffer.concat([Buffer.from([0]), Buffer.from('content')])).digest();
    expect(Buffer.from(deriveKey(secret, 'Joy Content', ['content']))).toEqual(child.subarray(0, 32));
  });
  it('the perimeter key is the daemon\'s derivation', () => {
    const root = createHmac('sha512', Buffer.from('Joy Relay Master Seed')).update(Buffer.from(secret)).digest();
    const child = createHmac('sha512', root.subarray(32)).update(Buffer.concat([Buffer.from([0]), Buffer.from('perimeter')])).digest();
    expect(relayPerimeterKey(secret)).toBe(child.subarray(0, 32).toString('hex'));
  });
  it('parses the app\'s dashed base32 backup code and the bare base64url form to the same secret', () => {
    const b64url = Buffer.from(secret).toString('base64url');
    expect(parseBackupCode(b64url)).toEqual(secret);
    // dashed base32 of the same bytes, with the typo forgiveness
    const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = 0, buf = 0, out = '';
    for (const byte of secret) { buf = (buf << 8) | byte; bits += 8; while (bits >= 5) { bits -= 5; out += A[(buf >> bits) & 31]; } }
    if (bits > 0) out += A[(buf << (5 - bits)) & 31];
    const dashed = out.match(/.{1,5}/g).join('-').toLowerCase().replace(/o/g, '0');
    expect(parseBackupCode(dashed)).toEqual(secret);
  });
});

describe('envelopes and payloads', () => {
  const content = contentKeyPair(secret);
  it('opens a session key envelope sealed to the content public key (the daemon\'s v2sk1 form)', () => {
    const sessionKey = new Uint8Array(randomBytes(32));
    const env = sealSessionKeyEnvelope(sessionKey, content.publicKey);
    expect(env.startsWith('v2sk1:')).toBe(true);
    expect(openSessionKeyEnvelope(env, content.secretKey)).toEqual(sessionKey);
    expect(openSessionKeyEnvelope('wrapped-key', content.secretKey)).toBeNull();
    expect(openSessionKeyEnvelope(env, contentKeyPair(new Uint8Array(randomBytes(32))).secretKey)).toBeNull();
  });
  it('a prompt sealed here opens as { t: plain } with the session key, and a record opens as a record', () => {
    const key = new Uint8Array(randomBytes(32));
    expect(openPayload(sealText('hello', key), key)).toEqual({ t: 'plain', text: 'hello', attachments: [] });
    const rec = { role: 'session', content: { type: 'session', data: { time: 1, turn: 'T1', ev: { t: 'text', text: 'hi' } } } };
    const nonce = new Uint8Array(randomBytes(24));
    const ct = nacl.secretbox(utf8(JSON.stringify({ v: 1, t: 'record', record: rec })), nonce, key);
    const wire = 'v2e1:' + b64(new Uint8Array([...nonce, ...ct]));
    expect(openPayload(wire, key)).toEqual({ t: 'record', record: rec });
    expect(openPayload(wire, new Uint8Array(randomBytes(32)))).toBeNull();
    expect(openPayload(JSON.stringify({ v: 1, t: 'plain', text: 'plain row' }), null)).toEqual({ t: 'plain', text: 'plain row', attachments: [] });
  });
  it('cards and spawn specs use the same secretbox form', () => {
    const key = new Uint8Array(randomBytes(32));
    expect(openCard(sealCard({ summary: { text: 'T' }, path: '/x' }, key), key)).toEqual({ summary: { text: 'T' }, path: '/x' });
    const machineKey = new Uint8Array(randomBytes(32));
    const wire = sealSpawnSpec({ cwd: '/p', agent: 'codex' }, machineKey, 'm1');
    expect(openV2Json(wire, deriveKey(machineKey, 'Joy Spawn Spec', ['m1']))).toEqual({ v: 1, t: 'spawn', cwd: '/p', agent: 'codex' });
    expect(JSON.parse(sealSpawnSpec({ cwd: '/p' }, null, 'm1'))).toEqual({ v: 1, t: 'spawn', cwd: '/p' });
  });
  it('a machine key (0x00 ‖ box) opens with the content key; its metadata is AES-256-GCM under that key', () => {
    const machineKey = new Uint8Array(randomBytes(32));
    const sealed = sealMachineKey(machineKey, content.publicKey);
    expect(openMachineKey(sealed, content.secretKey)).toEqual(machineKey);
    const meta = sealMachineMetadata({ host: 'fny', platform: 'linux' }, machineKey);
    expect(Buffer.from(meta, 'base64')[0]).toBe(0);
    expect(openMachineMetadata(meta, machineKey)).toEqual({ host: 'fny', platform: 'linux' });
    expect(openMachineMetadata(meta, new Uint8Array(randomBytes(32)))).toBeNull();
  });
  it('the login keypair is ed25519 from the secret as seed', () => {
    const kp = signKeyPair(secret);
    const msg = utf8('challenge');
    expect(nacl.sign.detached.verify(msg, nacl.sign.detached(msg, kp.secretKey), kp.publicKey)).toBe(true);
  });
});

describe('tunnel', () => {
  const machineKey = new Uint8Array(randomBytes(32));
  const tk = deriveTunnelKey(machineKey, 'machine-1');
  it('round-trips a request and a bound response through a daemon-side opener', () => {
    const body = utf8(JSON.stringify({ text: 'x'.repeat(300_000) })); // > 2 chunks
    const { wire, binding } = sealTunnelRequest(tk, { m: 'POST', p: '/v2/send', h: { 'content-type': 'application/json' }, t: 1 }, body);
    const req = openTunnelRequest(tk, wire);
    expect(req.head).toEqual({ m: 'POST', p: '/v2/send', h: { 'content-type': 'application/json' }, t: 1 });
    expect(fromUtf8(req.body)).toBe(fromUtf8(body));
    expect(req.binding).toBe(binding);
    const reply = sealTunnelResponse(tk, { s: 200, h: {}, r: req.binding }, utf8('{"ok":true}'));
    const res = openTunnelResponse(tk, reply, binding);
    expect(res.head.s).toBe(200);
    expect(fromUtf8(res.body)).toBe('{"ok":true}');
  });
  it('refuses a response bound to another request, and a tampered frame', () => {
    const a = sealTunnelRequest(tk, { m: 'GET', p: '/a', h: {}, t: 1 });
    const b = sealTunnelRequest(tk, { m: 'GET', p: '/b', h: {}, t: 1 });
    const replyForA = sealTunnelResponse(tk, { s: 200, h: {}, r: a.binding }, utf8('A'));
    expect(() => openTunnelResponse(tk, replyForA, b.binding)).toThrow(TunnelError);
    const tampered = new Uint8Array(replyForA); tampered[30] ^= 0xff;
    expect(() => openTunnelResponse(tk, tampered, a.binding)).toThrow(/tamper/);
  });
});
