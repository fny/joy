// Sealed environment store — provider keys (FIREWORKS_API_KEY, …) that every
// spawned agent needs, kept at ~/.joy/env.sealed (AES-256-GCM in the same
// [0x00][nonce12][ct][tag16] framing the machine card uses). Replaces the
// plaintext ~/.joy/env.
//
// The store is MACHINE-wide and so is its key: ~/.joy/env.key, 32 random
// bytes minted on first write (0600). It used to be sealed under the relay
// pairing's `machineKey` (access.key) — but a JOY_HOME_DIR can hold several
// relay pairings, each with its own machineKey, all pointing at the ONE
// env.sealed: a key set through relay A's daemon left relay B's daemon with
// store_unreadable and agents without provider keys (#533). A store sealed
// under a relay key is still opened (this relay's key, then every sibling
// pairing's) and re-sealed under the local key on first read.
//
// Several relay daemons share the file, so every read/modify/write runs as
// ONE transaction under the OS-backed lock at ~/.joy/env.lock.db, the key is
// published exclusively (the first mint wins; a concurrent minter adopts it),
// and temporary files are owned by the attempt (pid + nonce). Two daemons'
// first writes used to race: the second minted its own key over the first's
// and sealed a store holding only its own variable (#533 residual).
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
import { existsSync, readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, readdirSync, linkSync } from "node:fs";
import { join } from "node:path";
import { joyHomeDir } from "../paths";
import { loadCredentials } from "../relay/relay";

type SqliteDb = { exec(sql: string): void; close(): void };
// Resolved through process.getBuiltinModule (Node ≥ 22.3) rather than a
// static import so loaders that compile this file to CommonJS (test
// harnesses) work the same as the daemon's ESM runtime.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as unknown as { DatabaseSync: new (p: string) => SqliteDb };

const FILE = "env.sealed";
const KEY_FILE = "env.key";
const LOCK_FILE = "env.lock.db";
let warnedUnreadable = false;
let warnedDropped = "";
const LEGACY_FILE = "env";

function storePath(): string { return join(joyHomeDir(), FILE); }
function keyPath(): string { return join(joyHomeDir(), KEY_FILE); }
function lockPath(): string { return join(joyHomeDir(), LOCK_FILE); }
function legacyPath(): string { return join(joyHomeDir(), LEGACY_FILE); }

/** A temporary path no other attempt (this process or another daemon) can
 *  share: a fixed `<file>.tmp` let two writers truncate each other's
 *  half-written file and rename the wrong bytes into place. */
function tmpPath(target: string): string { return `${target}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`; }

// ── the store lock ───────────────────────────────────────────────────────────
// One writer at a time across every daemon on the machine, for the COMPLETE
// read-modify-publish transaction. The lock is an SQLite connection holding
// `BEGIN IMMEDIATE` on env.lock.db — the pattern singleton.ts uses for the
// daemon lock: the OS (fcntl) lock is atomic, blocks a second taker for up
// to `waitMs` (SQLite's busy handler sleeps inside the synchronous call, so
// the callers — setEnvVar, unsetEnvVar, migration — stay synchronous by
// contract), and dies with the process, so there is nothing to reclaim. The
// O_EXCL env.lock file it replaces was "broken" on mtime age alone: a writer
// paused between its temp write and its rename for ten seconds had its lock
// stolen by a second daemon, then renamed its stale snapshot over the second
// daemon's accepted write (#533 residual). No age heuristic can tell a slow
// holder from a dead one; an OS lock does not need to.
const timing = { waitMs: 5000 };
/** Test hook: shorten the wait so a held-lock case runs in milliseconds. */
export function __setEnvLockTimingForTests(t: Partial<typeof timing>): void { Object.assign(timing, t); }

/** Test hook: runs inside the lock, after the sealed store is written to its
 *  temporary file and before it is renamed into place — the point at which a
 *  paused writer used to be robbed of its lock. */
const hooks: { beforePublish?: () => void } = {};
export function __setEnvStoreHooksForTests(h: typeof hooks): void { Object.assign(hooks, h); }

function withStoreLock<T>(fn: () => T): T | { ok: false; error: string } {
  mkdirSync(joyHomeDir(), { recursive: true });
  const db = new DatabaseSync(lockPath());
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(timing.waitMs))}`);
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    try { db.close(); } catch { /* best effort */ }
    if (/locked|busy/i.test(String((e as Error).message ?? e))) return { ok: false, error: "store_busy" };
    throw e;
  }
  try {
    return fn();
  } finally {
    try { db.exec("ROLLBACK"); } catch { /* connection may already be closed */ }
    try { db.close(); } catch { /* best effort */ }
  }
}

/** A dictionary with NO prototype: `__proto__` is a legal variable name, and
 *  on a plain object `out["__proto__"] = v` hits the prototype setter and the
 *  variable silently vanished after a successful save (#534). Membership
 *  tests use Object.hasOwn for the same reason. */
function envDict(): Record<string, string> { return Object.create(null) as Record<string, string>; }

// ── keys ─────────────────────────────────────────────────────────────────────

function readLocalKey(): Uint8Array | null {
  try {
    const k = Buffer.from(readFileSync(keyPath(), "utf8").trim(), "base64");
    return k.length === 32 ? new Uint8Array(k) : null;
  } catch { return null; }
}

/** The machine-local store key, minted on first use (#533). Publication is
 *  EXCLUSIVE: the fully written candidate is hard-linked into place, which
 *  fails when a key already exists — then that key is adopted. A rename
 *  would silently replace a sibling daemon's key and orphan its store. */
function ensureLocalKey(): Uint8Array {
  const cur = readLocalKey();
  if (cur) return cur;
  mkdirSync(joyHomeDir(), { recursive: true });
  const k = randomBytes(32);
  const tmp = tmpPath(keyPath());
  writeFileSync(tmp, k.toString("base64") + "\n", { mode: 0o600 });
  try {
    try {
      linkSync(tmp, keyPath());
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        const existing = readLocalKey();
        if (existing) return existing;
        throw new Error("env.key exists but is not a 32-byte key");
      }
      // A filesystem without hard links: exclusive create is the fallback.
      writeFileSync(keyPath(), k.toString("base64") + "\n", { flag: "wx", mode: 0o600 });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readLocalKey();
      if (existing) return existing;
    }
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
  return new Uint8Array(k);
}

/** Relay pairing machineKeys — the keys stores were sealed under before the
 *  store had its own (#533): this relay's first, then every sibling pairing
 *  under the same JOY_HOME_DIR. Read-only; never written to. */
function relayMachineKeys(): Uint8Array[] {
  const out: Uint8Array[] = [];
  const seen = new Set<string>();
  const add = (k: Uint8Array | null | undefined) => {
    if (!k || k.length !== 32) return;
    const id = Buffer.from(k).toString("base64");
    if (seen.has(id)) return;
    seen.add(id);
    out.push(k);
  };
  add(loadCredentials()?.encryption.machineKey);
  const relays = join(joyHomeDir(), "relays");
  let dirs: string[] = [];
  try { dirs = readdirSync(relays); } catch { /* no pairings */ }
  for (const d of dirs) {
    try {
      const ak = JSON.parse(readFileSync(join(relays, d, "access.key"), "utf8")) as { encryption?: { machineKey?: string } };
      if (typeof ak.encryption?.machineKey === "string") add(new Uint8Array(Buffer.from(ak.encryption.machineKey, "base64")));
    } catch { /* not a pairing dir */ }
  }
  return out;
}

// ── sealing ──────────────────────────────────────────────────────────────────

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
    const out = envDict();
    for (const [k, v] of Object.entries(parsed)) if (typeof v === "string") out[k] = v;
    return out;
  } catch { return null; }
}

/** Parse the legacy KEY=value file (export prefixes and comments tolerated). */
export function parseEnvFile(text: string): Record<string, string> {
  const out = envDict();
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

/** A C string cannot carry NUL: Node truncates `process.env[k]` at the first
 *  one, so a value accepted here with a NUL reached agents as a DIFFERENT
 *  value than the one the store confirmed (#535). Rejected at the door — and
 *  on the way out (`validated`), since a store sealed by the version that
 *  accepted such a value is still on disk. */
export function isValidEnvValue(value: unknown): value is string { return typeof value === "string" && !value.includes("\0"); }

/** Split a decoded store into the values the environment can carry and the
 *  names of those it cannot. A dropped value is never applied (it would be
 *  silently truncated) and never resealed: the next write drops it from the
 *  file, and applyEnvStore says so once. */
function validated(raw: Record<string, string>): { env: Record<string, string>; dropped: string[] } {
  const env = envDict();
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (isValidEnvValue(v)) env[k] = v;
    else dropped.push(k);
  }
  return { env, dropped };
}

/** Does this machineKey (base64) open the current store? True when there is
 *  no store yet, and true once the store is sealed under its own local key
 *  (then no relay key matters). Pairing uses it to pick the key that matches
 *  an existing env.sealed instead of an arbitrary sibling relay's (#117). */
export function machineKeyOpensStore(keyB64: string): boolean {
  if (!existsSync(storePath())) return true;
  try {
    const b64 = readFileSync(storePath(), "utf8").trim();
    const local = readLocalKey();
    if (local && open(b64, local) !== null) return true;
    const key = Buffer.from(keyB64, "base64");
    if (key.length !== 32) return false;
    return open(b64, new Uint8Array(key)) !== null;
  } catch { return false; }
}

export type EnvStoreRead =
  | { ok: true; env: Record<string, string>; /** Names whose sealed value the environment cannot carry (#535). */ dropped?: string[] }
  | { ok: false; error: string };

/** Decode the store as it is on disk: under the local key, else under a relay
 *  pairing's machineKey (`legacy: true`). No writes. */
function decodeStore(): (EnvStoreRead & { legacy?: boolean }) {
  if (!existsSync(storePath())) return { ok: true, env: envDict() };
  let b64: string;
  try { b64 = readFileSync(storePath(), "utf8").trim(); } catch { return { ok: false, error: "store_unreadable" }; }
  const done = (raw: Record<string, string>, legacy: boolean): EnvStoreRead & { legacy?: boolean } => {
    const { env, dropped } = validated(raw);
    return dropped.length ? { ok: true, env, dropped, legacy } : { ok: true, env, legacy };
  };
  const local = readLocalKey();
  if (local) {
    const raw = open(b64, local);
    if (raw) return done(raw, false);
  }
  for (const k of relayMachineKeys()) {
    const raw = open(b64, k);
    if (raw) return done(raw, true);
  }
  return { ok: false, error: "store_unreadable" };
}

/** The store's contents, or an error string when it cannot be read (a
 *  tampered file fails authentication; a store sealed under a key that is
 *  gone cannot be opened). A store still sealed under a relay pairing's
 *  machineKey (#533) is re-sealed under the local key so every relay's
 *  daemon reads it from here on — inside the lock, and only if it is still
 *  legacy once the lock is held. */
export function readEnvStore(): EnvStoreRead {
  const cur = decodeStore();
  if (!cur.ok) return cur;
  const { legacy, ...read } = cur;
  if (!legacy) return read;
  try {
    withStoreLock(() => {
      const again = decodeStore();
      if (again.ok && again.legacy) writeEnvStore(again.env);
    });
  } catch { /* still readable through this relay */ }
  return read;
}

function writeEnvStore(env: Record<string, string>): { ok: true } | { ok: false; error: string } {
  const key = ensureLocalKey();
  mkdirSync(joyHomeDir(), { recursive: true });
  const tmp = tmpPath(storePath());
  try {
    writeFileSync(tmp, seal(env, key) + "\n", { mode: 0o600 });
    hooks.beforePublish?.();
    renameSync(tmp, storePath());
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
  return { ok: true };
}

export function setEnvVar(name: string, value: string): { ok: true } | { ok: false; error: string } {
  if (!isValidEnvName(name)) return { ok: false, error: "bad_name" };
  if (!isValidEnvValue(value)) return { ok: false, error: "bad_value" };
  return withStoreLock(() => {
    const cur = decodeStore();
    if (!cur.ok) return cur;
    const next = envDict();
    Object.assign(next, cur.env);
    next[name] = value;
    return writeEnvStore(next);
  });
}

export function unsetEnvVar(name: string): { ok: true; existed: boolean } | { ok: false; error: string } {
  return withStoreLock(() => {
    const cur = decodeStore();
    if (!cur.ok) return cur;
    const existed = Object.hasOwn(cur.env, name);
    const next = envDict();
    Object.assign(next, cur.env);
    delete next[name];
    const w = writeEnvStore(next);
    return w.ok ? { ok: true, existed } : w;
  });
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
  // A value the environment cannot carry is not applied at all — installing
  // it would hand agents a silently truncated value (#535). Said once per
  // distinct set of names.
  if (cur.dropped?.length) {
    const key = cur.dropped.join(",");
    if (warnedDropped !== key) { warnedDropped = key; process.stderr.write(`[env] ${storePath()}: the value(s) of ${cur.dropped.join(", ")} contain a NUL byte and cannot be environment values — not applied; set them again to replace them\n`); }
  }
  for (const k of appliedFromStore) {
    if (!Object.hasOwn(cur.env, k)) { delete process.env[k]; appliedFromStore.delete(k); }
  }
  for (const [k, v] of Object.entries(cur.env)) {
    if (Object.hasOwn(process.env, k) && !appliedFromStore.has(k)) continue; // service env wins
    process.env[k] = v;
    appliedFromStore.add(k);
  }
}

/** One-shot migration: a plaintext ~/.joy/env is sealed into the store and
 *  deleted. Values the environment cannot carry (NUL, #535) are skipped with
 *  a note rather than sealed and later truncated at spawn. */
export function migrateLegacyEnvFile(log: (line: string) => void = () => {}): void {
  if (!existsSync(legacyPath())) return;
  const parsed = envDict();
  for (const [k, v] of Object.entries(parseEnvFile(readFileSync(legacyPath(), "utf8")))) {
    if (isValidEnvValue(v)) parsed[k] = v;
    else log(`[env] ~/.joy/env: ${k} contains a NUL byte and cannot be an environment value — skipped`);
  }
  const w = withStoreLock((): { ok: true } | { ok: false; error: string } => {
    const cur = decodeStore();
    if (!cur.ok) return cur;
    const merged = envDict();
    Object.assign(merged, parsed, cur.env); // an existing sealed value wins
    return writeEnvStore(merged);
  });
  if (!w.ok) {
    if (w.error === "store_busy") { log(`[env] could not seal ~/.joy/env: ${w.error}`); return; }
    log(`[env] ~/.joy/env is plaintext and cannot be sealed yet (${w.error}); loading it as-is`);
    for (const [k, v] of Object.entries(parsed)) if (!Object.hasOwn(process.env, k)) process.env[k] = v;
    return;
  }
  try { unlinkSync(legacyPath()); } catch { /* leave it */ }
  log(`[env] sealed ${Object.keys(parsed).length} variable(s) from ~/.joy/env into env.sealed and removed the plaintext file`);
}
