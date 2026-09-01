// Bearer → account id. The relay IS the account authority: tokens are
// verified locally (see tokens.mjs) and must name an account that exists in
// the store, so a token from a deleted account stops working immediately.
// A short positive cache keeps the per-request cost to a Map lookup.
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE = 5000;

export function createAuth({ tokens, accounts }) {
  const cache = new Map(); // token -> { accountId, at }

  async function verifyToken(token) {
    if (!token) return null;
    const hit = cache.get(token);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.accountId;
    const v = tokens.verifyToken(token);
    if (!v) return null;
    if (!(await accounts.accountExists(v.accountId))) return null;
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
    cache.set(token, { accountId: v.accountId, at: Date.now() });
    return v.accountId;
  }

  return { verifyToken };
}
