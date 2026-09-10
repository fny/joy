// The one account this server is: its secret, its relay, its bearer. Stored
// owner-only under JOY_MCP_HOME (default ~/.joy-mcp). The secret never leaves
// this file and memory; tokens are renewed from it.
//
// Two ways in:
//   pair --secret   paste the account backup code (what `joy auth` takes)
//   pair            show a joy:///account?… QR / link; approve it in the joy app
//                   (the app's "connect a device" flow, account flavour) — the
//                   app seals the secret to a fresh keypair we hold.
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes, createHmac } from 'node:crypto';
import nacl from 'tweetnacl';
import { b64, unb64, openBox, contentKeyPair, signKeyPair, relayPerimeterKey, parseBackupCode } from './crypto.mjs';
import { loginWithSecret } from './relay.mjs';

export function mcpHome() {
  return (process.env.JOY_MCP_HOME || join(homedir(), '.joy-mcp')).replace(/\/$/, '');
}
export function ensureHome(dir = mcpHome()) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* umask */ }
  return dir;
}

const FILE = 'account.json';

export function loadAccount(dir = mcpHome()) {
  const p = join(dir, FILE);
  if (!existsSync(p)) return null;
  const j = JSON.parse(readFileSync(p, 'utf8'));
  return { ...j, secret: unb64(j.secret) };
}
export function saveAccount(acct, dir = ensureHome()) {
  const p = join(dir, FILE);
  const out = { ...acct, secret: b64(acct.secret) };
  writeFileSync(p, JSON.stringify(out, null, 2), { mode: 0o600 });
  try { chmodSync(p, 0o600); } catch { /* umask */ }
}

/** Everything derived from the secret that the server needs at runtime. */
export function keysFor(secret) {
  const content = contentKeyPair(secret);
  const sign = signKeyPair(secret);
  return { content, sign, perimeterKey: relayPerimeterKey(secret), accountPublicKey: b64(sign.publicKey) };
}

/** Pair from a pasted backup code: log in, keep the secret. */
export async function pairWithSecret(relayUrl, code, dir = ensureHome()) {
  const secret = parseBackupCode(code);
  const keys = keysFor(secret);
  const perimeterKey = process.env.JOY_RELAY_ACCESS_KEY?.trim() || keys.perimeterKey;
  const { token, publicKey } = await loginWithSecret(relayUrl, secret, { perimeterKey });
  const acct = { relayUrl: relayUrl.replace(/\/$/, ''), secret, token, accountPublicKey: publicKey, pairedAt: Date.now() };
  saveAccount(acct, dir);
  return acct;
}

const PAIRING_PROOF_LABEL = 'joy-pairing-proof-v1';
function pairingProof(kp, handshake) {
  const { challenge, relayPublicKey } = handshake ?? {};
  if (typeof challenge !== 'string' || typeof relayPublicKey !== 'string') return undefined;
  const relayPub = unb64(relayPublicKey); const nonce = unb64(challenge);
  if (relayPub.length !== 32 || !nonce.length) return undefined;
  const shared = nacl.scalarMult(kp.secretKey, relayPub);
  const msg = Buffer.concat([Buffer.from(PAIRING_PROOF_LABEL), Buffer.from(nonce), Buffer.from(kp.publicKey), Buffer.from(relayPub)]);
  return createHmac('sha256', Buffer.from(shared)).update(msg).digest('base64');
}

/** Pair by approval from the joy app (account flavour). `onCode(link)` gets
 *  the joy:///account?… payload to show; resolves when the app answers. */
export async function pairWithApp(relayUrl, { onCode, timeoutMs = 20 * 60_000, pollMs = 2_000, perimeterKey } = {}, dir = ensureHome()) {
  const base = relayUrl.replace(/\/$/, '');
  const kp = nacl.box.keyPair.fromSecretKey(new Uint8Array(randomBytes(32)));
  const headers = { 'content-type': 'application/json', 'x-joy-client': 'joy-mcp' };
  if (perimeterKey) headers['x-joy-relay-key'] = perimeterKey;
  const post = async (body) => {
    const r = await fetch(`${base}/joy/v2/auth/account/request`, { method: 'POST', headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`pairing request failed: HTTP ${r.status} ${j?.error ?? ''}`);
    return j ?? {};
  };
  let handshake = await post({ publicKey: b64(kp.publicKey), supportsV2: true });
  onCode?.(`joy:///account?${Buffer.from(kp.publicKey).toString('base64url')}`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const proof = pairingProof(kp, handshake);
    const resp = await post({ publicKey: b64(kp.publicKey), supportsV2: true, ...(proof ? { proof } : {}) });
    if (resp.challenge) handshake = resp;
    if (resp.state === 'authorized') {
      const secret = openBox(unb64(String(resp.response)), kp.secretKey);
      if (!secret || secret.length !== 32) throw new Error('the approval could not be opened');
      const keys = keysFor(secret);
      const acct = { relayUrl: base, secret, token: String(resp.token ?? ''), accountPublicKey: keys.accountPublicKey, pairedAt: Date.now() };
      if (!acct.token) acct.token = (await loginWithSecret(base, secret, { perimeterKey: perimeterKey || keys.perimeterKey })).token;
      saveAccount(acct, dir);
      return acct;
    }
    if (resp.state === 'consumed' || resp.state === 'expired') throw new Error(`pairing ${resp.state}: ${resp.message ?? 'start again'}`);
  }
  throw new Error('pairing timed out — nobody approved it in the app');
}

/** Does this backup code belong to the paired account? (The OAuth login.) */
export function codeMatchesAccount(code, acct) {
  try {
    const secret = parseBackupCode(code);
    return b64(signKeyPair(secret).publicKey) === acct.accountPublicKey;
  } catch { return false; }
}
