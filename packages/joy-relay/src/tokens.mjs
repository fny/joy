// Bearer tokens: EdDSA JWTs minted and verified locally. The signing key is
// derived from ONE secret (JOY_RELAY_TOKEN_SECRET) per issuer with
// pbkdf2-sha512(secret, `${issuer} Persistent Token`, 210000, 64)[0:32] as the
// ed25519 seed. Several issuers can verify at once (first one mints), so a
// deployment can rotate its issuer label without invalidating tokens that
// devices already hold — the only state a device keeps is its token.
// Zero deps: node:crypto does ed25519 + pbkdf2 natively.
import { createPrivateKey, createPublicKey, pbkdf2, randomUUID, sign, verify } from 'node:crypto';

// PKCS8 / SPKI DER prefixes for raw ed25519 keys (RFC 8410).
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(s, 'base64url');

function deriveSeed(secret, issuer) {
  return new Promise((resolve, reject) =>
    pbkdf2(secret, `${issuer} Persistent Token`, 210_000, 64, 'sha512', (err, key) =>
      err ? reject(err) : resolve(key.subarray(0, 32))));
}

/**
 * @param {{ secret: string, issuers?: string[] }} opts
 *   issuers: accepted `iss` values; the first is used for minting. Default ['joy'].
 */
export async function createTokenAuthority({ secret, issuers }) {
  if (!secret || typeof secret !== 'string' || secret.length < 16) {
    throw new Error('token secret must be a string of at least 16 characters');
  }
  const list = (issuers && issuers.length > 0 ? issuers : ['joy']).map((s) => s.trim()).filter(Boolean);
  const keys = new Map(); // issuer -> { privateKey, publicKey }
  for (const iss of list) {
    const seed = await deriveSeed(secret, iss);
    const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
    const publicKey = createPublicKey(privateKey);
    keys.set(iss, { privateKey, publicKey });
  }
  const mintIssuer = list[0];
  const header = b64url(JSON.stringify({ alg: 'EdDSA' }));

  /** Mint a non-expiring bearer for an account. `extras` are extra claims. */
  function mint(accountId, extras = {}) {
    const now = Math.floor(Date.now() / 1000);
    const payload = { sub: accountId, ...extras, iat: now, nbf: now, iss: mintIssuer, jti: randomUUID() };
    const signingInput = `${header}.${b64url(JSON.stringify(payload))}`;
    const sig = sign(null, Buffer.from(signingInput), keys.get(mintIssuer).privateKey);
    return `${signingInput}.${b64url(sig)}`;
  }

  /** → { accountId, extras } or null. Signature must match the payload's
   *  issuer's key; unknown issuers, bad shapes and future nbf all reject. */
  function verifyToken(token) {
    if (typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let hdr, payload;
    try {
      hdr = JSON.parse(fromB64url(parts[0]).toString('utf8'));
      payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch { return null; }
    if (!hdr || hdr.alg !== 'EdDSA' || !payload || typeof payload.sub !== 'string') return null;
    const k = keys.get(payload.iss);
    if (!k) return null;
    let ok = false;
    try { ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), k.publicKey, fromB64url(parts[2])); } catch { ok = false; }
    if (!ok) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
    if (typeof payload.exp === 'number' && payload.exp <= now) return null;
    const { iss, sub, aud, jti, nbf, exp, iat, ...extras } = payload;
    return { accountId: sub, extras };
  }

  return { mint, verifyToken, issuer: mintIssuer, issuers: list };
}
