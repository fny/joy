// Sealed environment store — provider keys (FIREWORKS_API_KEY, …) that every
// spawned agent needs, kept at ~/.joy/env.sealed under the MACHINE key
// (access.key `machineKey`, AES-256-GCM in the same [0x00][nonce12][ct][tag16]
// framing the machine card uses). Replaces the plaintext ~/.joy/env.
//
// What sealing buys: protection against file-level exposure (backups, a
// stray `cat`, permissive modes). What it does not: the daemon holds the key
// on the same disk, and spawned agents receive plaintext env (that is how
// provider SDKs read keys) — so a same-uid process can always get at them.
//
// Reads happen at EVERY spawn (applyEnvStore), for every agent, so a key set
// from the app or `joy env set` reaches the next session without a daemon
// restart. Values set here never override a variable the daemon's own
// environment already carries (service env / shell wins), matching the old
// ~/.joy/env contract.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { joyHomeDir } from "../paths";
import { loadCredentials } from "../relay/relay";

const FILE = "env.sealed";
let warnedUnreadable = false;
const LEGACY_FILE = "env";

function storePath(): string { return join(joyHomeDir(), FILE); }
function legacyPath(): string { return join(joyHomeDir(), LEGACY_FILE); }

function machineKey(): Uint8Array | null {
  const creds = loadCredentials();
  const k = creds?.encryption.machineKey;
  return k && k.length === 32 ? k : null;
}

function seal(data: Record<string, string>, key: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const pt = Buffer.from(JSON.stringify(data), "utf8");
  const enc = Buffer.concat([cipher.update(pt), cipher.final()]);
  return Buffer.concat([Buffer.from([0]), nonce, enc, cipher.getAuthTag()]).toString("base64");
}

function open(b64: string, key: Uint8Array): Record<string, string> | null {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 1 + 12 + 16 || buf[0] !== 0) return null;
  const nonce = buf.subarray(1, 13);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(13, buf.length - 16);
  try {
    const d = createDecipheriv("aes-256-gcm", key, nonce);
    d.setAuthTag(tag);
    const parsed = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return null; }
}

/** Parse the legacy KEY=value file (export prefixes and comments tolerated). */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (key) out[key] = value;
  }
  return out;
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export function isValidEnvName(name: string): boolean { return NAME_RE.test(name); }

/** Does this machineKey (base64) open the current store? True when there is
 *  no store yet. Pairing uses it to pick the key that matches an existing
 *  env.sealed instead of an arbitrary sibling relay's (#117). */
export function machineKeyOpensStore(keyB64: string): boolean {
  if (!existsSync(storePath())) return true;
  try {
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) return false;
    return open(readFileSync(storePath(), "utf8").trim(), new Uint8Array(key)) !== null;
  } catch { return false; }
}

/** The store's contents, or an error string when it cannot be read (unpaired
 *  daemon has no machine key; a tampered file fails authentication). */
export function readEnvStore(): { ok: true; env: Record<string, string> } | { ok: false; error: string } {
  const key = machineKey();
  if (!key) return { ok: false, error: "no_machine_key" };
  if (!existsSync(storePath())) return { ok: true, env: {} };
  const env = open(readFileSync(storePath(), "utf8").trim(), key);
  return env ? { ok: true, env } : { ok: false, error: "store_unreadable" };
}

function writeEnvStore(env: Record<string, string>): { ok: true } | { ok: false; error: string } {
  const key = machineKey();
  if (!key) return { ok: false, error: "no_machine_key" };
  mkdirSync(joyHomeDir(), { recursive: true });
  const tmp = `${storePath()}.tmp`;
  writeFileSync(tmp, seal(env, key) + "\n", { mode: 0o600 });
  renameSync(tmp, storePath());
  return { ok: true };
}

export function setEnvVar(name: string, value: string): { ok: true } | { ok: false; error: string } {
  if (!isValidEnvName(name)) return { ok: false, error: "bad_name" };
  const cur = readEnvStore();
  if (!cur.ok) return cur;
  return writeEnvStore({ ...cur.env, [name]: value });
}

export function unsetEnvVar(name: string): { ok: true; existed: boolean } | { ok: false; error: string } {
  const cur = readEnvStore();
  if (!cur.ok) return cur;
  const existed = name in cur.env;
  const next = { ...cur.env };
  delete next[name];
  const w = writeEnvStore(next);
  return w.ok ? { ok: true, existed } : w;
}

/** Names only, for the app/CLI listing — values never leave the daemon in
 *  the clear except into a spawned agent's environment. */
export function listEnvVars(): { ok: true; names: string[] } | { ok: false; error: string } {
  const cur = readEnvStore();
  return cur.ok ? { ok: true, names: Object.keys(cur.env).sort() } : cur;
}

// Keys THIS process put into process.env from the store (so a removed
// variable is withdrawn on the next spawn, and a store value never shadows
// a variable the daemon inherited from its service environment).
const appliedFromStore = new Set<string>();

/** Refresh process.env from the store. Called at daemon boot and before every
 *  agent spawn: the per-session tmux server / app-server / pi process inherit
 *  process.env, so this is the one place all four agents pick keys up. */
export function applyEnvStore(): void {
  // An unreadable store is loud, once: silently skipping it lost every
  // provider key for every later spawn with no hint why (#117).
  { const probe = readEnvStore(); if (!probe.ok && existsSync(storePath()) && !warnedUnreadable) { warnedUnreadable = true; process.stderr.write(`[env] ${storePath()} is ${probe.error} — provider keys are NOT being applied; run \`joy env ls\` to inspect, or delete the file and set the keys again\n`); } }
  const cur = readEnvStore();
  if (!cur.ok) return;
  for (const k of appliedFromStore) {
    if (!(k in cur.env)) { delete process.env[k]; appliedFromStore.delete(k); }
  }
  for (const [k, v] of Object.entries(cur.env)) {
    if (k in process.env && !appliedFromStore.has(k)) continue; // service env wins
    process.env[k] = v;
    appliedFromStore.add(k);
  }
}

/** One-shot migration: a plaintext ~/.joy/env is sealed into the store and
 *  deleted. Requires the machine key (i.e. a paired daemon); otherwise the
 *  file is left alone and loaded plaintext as before, with a warning. */
export function migrateLegacyEnvFile(log: (line: string) => void = () => {}): void {
  if (!existsSync(legacyPath())) return;
  const parsed = parseEnvFile(readFileSync(legacyPath(), "utf8"));
  const cur = readEnvStore();
  if (!cur.ok) {
    log(`[env] ~/.joy/env is plaintext and cannot be sealed yet (${cur.error}); loading it as-is`);
    for (const [k, v] of Object.entries(parsed)) if (!(k in process.env)) process.env[k] = v;
    return;
  }
  const w = writeEnvStore({ ...parsed, ...cur.env }); // an existing sealed value wins
  if (!w.ok) { log(`[env] could not seal ~/.joy/env: ${w.error}`); return; }
  try { unlinkSync(legacyPath()); } catch { /* leave it */ }
  log(`[env] sealed ${Object.keys(parsed).length} variable(s) from ~/.joy/env into env.sealed and removed the plaintext file`);
}
