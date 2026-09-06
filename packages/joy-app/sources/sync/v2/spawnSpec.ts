/**
 * Spawn-spec envelope — what `POST /joy/v2/sessions` carries as `spawnSpec`
 * and the daemon's nucleus lane decodes to launch the agent
 * (packages/joy-daemon/src/relay/nucleusLane.ts decodeSpawnSpec).
 *
 * Today the spec travels as PLAIN JSON `{v:1,t:'spawn',cwd,…}` and the relay
 * stores it verbatim (packages/joy-relay/src/core.mjs createSession →
 * commands.ciphertext). Message content and cards have since been sealed,
 * which leaves this the one payload where absolute project paths, model
 * names, resume ids and `extraArgs` sit readable in the relay database
 * (#107).
 *
 * Proposed sealed contract (this module is the app half; the daemon half
 * does not exist yet, so NO caller passes a key today and the wire is
 * byte-for-byte what it was):
 *   key      : deriveKey(machineKey, 'Joy Spawn Spec', [machineId]) — a
 *              dedicated leaf of the same machine key-tree as the tunnel key
 *              (deriveKey(machineKey, 'Joy Tunnel', [machineId])), so both
 *              ends compute it and the relay never holds it. A separate
 *              usage label keeps random-nonce secretbox traffic off the
 *              tunnel key, whose per-stream subkeys use counter nonces.
 *   envelope : 'v2e1:' + b64(nonce24 ‖ secretbox(utf8(json), nonce, key)) —
 *              the SAME layout as sealed content/cards (crypto.ts,
 *              nucleusLane.openEnvelope), so the daemon needs no new codec.
 *   daemon   : decodeSpawnSpec(ciphertext) → if it starts with 'v2e1:' open
 *              with the spawn-spec key, else JSON.parse (old apps).
 *   app gate : send sealed only once the machine advertises support (a
 *              `spawnSpecSealed: true` field in its sealed metadata, or a
 *              daemon version floor) — a sealed spec to an older daemon is
 *              "no usable spawnSpec — skipped" and the create hangs until
 *              the deadline.
 */
import sodium from '@/encryption/libsodium.lib';
import { deriveKey } from '@/encryption/deriveKey';
import { decodeUTF8, encodeUTF8 } from '@/encryption/text';

export const SPAWN_SPEC_KEY_USAGE = 'Joy Spawn Spec';
const SEALED_PREFIX = 'v2e1:';

export type SpawnSpecPayload = Record<string, unknown> & { cwd: string };

/** The per-machine spawn-spec key (see the contract above). */
export async function deriveSpawnSpecKey(machineKey: Uint8Array, machineId: string): Promise<Uint8Array> {
    return deriveKey(machineKey, SPAWN_SPEC_KEY_USAGE, [machineId]);
}

/** Encode a spec for the wire. `key === null` → the current plain-JSON form
 *  (unchanged from before #107); a key → the sealed envelope. */
export function encodeSpawnSpec(spec: SpawnSpecPayload, key: Uint8Array | null): string {
    const json = JSON.stringify({ v: 1, t: 'spawn', ...spec });
    if (!key) return json;
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    // encodeUTF8, not sodium.from_string: the native module has no from_string.
    const ct = sodium.crypto_secretbox_easy(encodeUTF8(json), nonce, key);
    const buf = new Uint8Array(nonce.length + ct.length);
    buf.set(nonce, 0);
    buf.set(ct, nonce.length);
    return SEALED_PREFIX + sodium.to_base64(buf, sodium.base64_variants.ORIGINAL);
}

/** The daemon-side decode, mirrored here so the contract is pinned by a test
 *  on this side too: sealed → needs the key; plain → JSON. null on a
 *  tampered/foreign envelope or anything that is not a spawn spec. */
export function openSpawnSpec(wire: string | null | undefined, key: Uint8Array | null): SpawnSpecPayload | null {
    if (!wire) return null;
    try {
        let json: string;
        if (wire.startsWith(SEALED_PREFIX)) {
            if (!key) return null;
            const raw = sodium.from_base64(wire.slice(SEALED_PREFIX.length), sodium.base64_variants.ORIGINAL);
            const n = sodium.crypto_secretbox_NONCEBYTES;
            if (raw.length < n + sodium.crypto_secretbox_MACBYTES) return null;
            json = decodeUTF8(sodium.crypto_secretbox_open_easy(raw.slice(n), raw.slice(0, n), key));
        } else {
            json = wire;
        }
        const p = JSON.parse(json) as { t?: unknown; cwd?: unknown } | null;
        if (p && p.t === 'spawn' && typeof p.cwd === 'string') return p as SpawnSpecPayload;
        return null;
    } catch {
        return null;
    }
}
