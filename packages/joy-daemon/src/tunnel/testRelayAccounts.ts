// Test-only: stand up the relay's NATIVE account plane (tokens + accounts +
// auth) against a test db and mint bearers for two fresh accounts, so the
// in-process tunnel e2e tests exercise the real verifyToken path instead of
// a stub. Mirrors server.mjs wiring.
import { generateKeyPairSync, sign, randomBytes } from "node:crypto";
import { createTokenAuthority } from "../../../joy-relay/src/tokens.mjs";
import { createAccounts } from "../../../joy-relay/src/accounts.mjs";
import { createAuth } from "../../../joy-relay/src/auth.mjs";

export interface TestRelayAccounts {
  auth: { verifyToken(token: string): Promise<string | null> };
  accounts: any;
  tokA: string;
  tokB: string;
}

export async function createTestRelayAccounts(db: any): Promise<TestRelayAccounts> {
  const tokens = await createTokenAuthority({ secret: "joy-daemon-test-secret-0123456789" });
  const accounts = createAccounts(db, tokens, { fetchImpl: async () => ({ ok: true, json: async () => ({ data: [] }) }) });
  const auth = createAuth({ tokens, accounts });
  async function loginNew(): Promise<string> {
    const kp = generateKeyPairSync("ed25519");
    const raw = (kp.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
    const challenge = randomBytes(32);
    const r = await accounts.login({
      publicKey: raw.toString("base64"),
      challenge: challenge.toString("base64"),
      signature: sign(null, challenge, kp.privateKey).toString("base64"),
    });
    return String(r.token);
  }
  return { auth, accounts, tokA: await loginNew(), tokB: await loginNew() };
}
