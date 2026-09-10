// The CLI's half of automations: talk to the relay as the account, and seal a
// spawn spec the way the daemon on THIS machine will open it.
//
// The sealing is why `joy automation create` can only author for the machine
// it runs on. A spec is sealed under the machine's spawn-spec key, derived
// from the machine data key this daemon holds — and it holds no account key,
// so it can derive no other machine's. Cross-machine authoring is the app's
// job; it has the account key and can reach every machine's.
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import tweetnacl from "tweetnacl";
import { joyRelayCredsDir, joyRelayUrl } from "../paths";
import { deriveSpawnSpecKey } from "../tunnel/sealedStream";

export interface RelayIdentity {
  token: string;
  machineId: string;
  serverUrl: string;
  /** Null when this install has no machine key: the spec then travels as
   *  plain JSON, which every daemon still accepts. */
  spawnSpecKey: Uint8Array | null;
}

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));

/** Credentials for the relay this install is paired to, or null when it is
 *  not paired at all (`joy auth`). */
export function relayIdentity(): RelayIdentity | null {
  const dir = joyRelayCredsDir();
  const keyPath = join(dir, "access.key");
  if (!existsSync(keyPath)) return null;
  let token = "";
  let machineKey: Uint8Array | null = null;
  try {
    const ak = JSON.parse(readFileSync(keyPath, "utf8")) as {
      token?: string;
      encryption?: { machineKey?: string };
    };
    token = ak.token ?? "";
    if (ak.encryption?.machineKey) machineKey = b64(ak.encryption.machineKey);
  } catch { return null; }
  if (!token) return null;

  let machineId = "";
  try {
    machineId = (JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")) as { machineId?: string }).machineId ?? "";
  } catch { /* settings optional */ }
  if (!machineId) return null;

  return {
    token,
    machineId,
    serverUrl: joyRelayUrl(),
    spawnSpecKey: machineKey && machineKey.length === 32 ? deriveSpawnSpecKey(machineKey, machineId) : null,
  };
}

/** The same envelope the daemon opens: "v2e1:" + b64(nonce ‖ secretbox). A
 *  machine with no key seals nothing and sends plain JSON, which the daemon
 *  still accepts — an automation should not be impossible to write just
 *  because this install predates the key. */
export function sealSpawnSpec(spec: Record<string, unknown>, key: Uint8Array | null): string {
  const json = JSON.stringify({ v: 1, t: "spawn", ...spec });
  if (!key) return json;
  const nonce = new Uint8Array(randomBytes(tweetnacl.secretbox.nonceLength));
  const ct = tweetnacl.secretbox(new Uint8Array(Buffer.from(json, "utf8")), nonce, key);
  return "v2e1:" + Buffer.concat([Buffer.from(nonce), Buffer.from(ct)]).toString("base64");
}

export interface RelayReply { status: number; body: any }

export async function relayCall(
  id: RelayIdentity,
  method: string,
  path: string,
  body?: unknown,
): Promise<RelayReply> {
  const res = await fetch(`${id.serverUrl}/joy/v2${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${id.token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch { /* non-json */ }
  return { status: res.status, body: parsed };
}
