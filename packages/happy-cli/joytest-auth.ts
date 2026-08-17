// E2E test helper: non-interactive daemon auth. Replicates happy-cli's
// waitForAuthentication WITHOUT the Ink TUI — POST /v1/auth/request, then poll
// until the web app (driven separately) approves, then write a dataKey access.key.
import { configuration } from "@/configuration";
import { decodeBase64, encodeBase64, encodeBase64Url } from "@/api/encryption";
import { decryptWithEphemeralKey } from "@/ui/auth";
import { writeCredentialsDataKey, writeCredentialsLegacy, updateSettings } from "@/persistence";
import { randomBytes, randomUUID } from "node:crypto";
import tweetnacl from "tweetnacl";
import axios from "axios";

async function main() {
  const secret = new Uint8Array(randomBytes(32));
  const keypair = tweetnacl.box.keyPair.fromSecretKey(secret);
  const pubB64 = encodeBase64(keypair.publicKey);
  const hdrs = { headers: { "X-Happy-Client": "cli/e2e" } };
  console.error("SERVER=" + configuration.serverUrl);
  console.error("HOME=" + configuration.happyHomeDir);
  console.error("APPROVE_KEY=" + encodeBase64Url(keypair.publicKey));
  await axios.post(`${configuration.serverUrl}/v1/auth/request`, { publicKey: pubB64, supportsV2: true }, hdrs);
  console.error("REQUEST_SENT");
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const resp = await axios.post(`${configuration.serverUrl}/v1/auth/request`, { publicKey: pubB64, supportsV2: true }, hdrs);
    if (resp.data.state !== "authorized") continue;
    const token = resp.data.token as string;
    const decrypted = decryptWithEphemeralKey(decodeBase64(resp.data.response), keypair.secretKey);
    if (!decrypted) { console.error("DECRYPT_FAILED"); process.exit(1); }
    if (decrypted.length === 32) {
      await writeCredentialsLegacy({ secret: decrypted, token });
      console.error("WROTE_LEGACY (warning: machineRPC will not work)");
    } else if (decrypted[0] === 0) {
      await writeCredentialsDataKey({ publicKey: decrypted.slice(1, 33), machineKey: new Uint8Array(randomBytes(32)), token });
      console.error("WROTE_DATAKEY");
    } else { console.error("BAD_RESPONSE"); process.exit(1); }
    const s = await updateSettings(async (st: any) => ({ ...st, machineId: st.machineId || randomUUID() }));
    console.error("DONE machineId=" + (s as any).machineId);
    process.exit(0);
  }
  console.error("TIMEOUT — not approved within 180s");
  process.exit(1);
}
main().catch((e) => { console.error("ERR", e?.message || e); process.exit(1); });
