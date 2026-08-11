// Token verification by delegation: the upstream happy-server IS the account
// authority until migration P5, so we verify a bearer token by asking it
// (GET /v1/account/profile) and cache the token→account binding. No shared
// master secret, no duplicated privacy-kit crypto; /v1/auth is owned last by
// design. Cache entries are positive-only and short so revocation upstream
// converges quickly.
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE = 5000;

export function createAuth({ upstreamHost, upstreamPort, fetchImpl }) {
  const cache = new Map(); // token -> { accountId, at }
  const doFetch = fetchImpl ?? fetch;

  async function verifyToken(token) {
    if (!token) return null;
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.accountId;
    let accountId = null;
    try {
      const r = await doFetch(`http://${upstreamHost}:${upstreamPort}/v1/account/profile`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const body = await r.json();
        accountId = body?.id ?? null;
      }
    } catch { /* upstream unreachable → treat as unauthenticated */ }
    if (accountId) {
      if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
      cache.set(token, { accountId, at: Date.now() });
    }
    return accountId;
  }

  return { verifyToken };
}
