// Session secrets — values the user hands one session (a login's email and
// password, a one-off token) without typing them into the chat. Kept at
// ~/.joy/secrets.sealed, BESIDE the env store and deliberately not in it:
// env values are applied to every agent at spawn (applyEnvStore), secrets
// never are. An agent reads one on demand with `joy secret get <name>`, for
// its own session only ($JOY_SESSION_ID picks the session).
//
// Session scoping keeps each agent's list short; it is not a security
// boundary — the id is an environment variable and the store's key sits on
// the same disk, so any same-uid process can reach every value. Sealing is
// the env store's: AES-256-GCM under ~/.joy/env.key, every write one
// transaction under the env store's OS lock.
//
// Names match without regard to case (`email` and `EMAIL` are one secret);
// the spelling last written is the one listed. A session's secrets are
// dropped when it is killed, and copied to a fork or a handoff target.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { joyHomeDir } from "../paths";
import { ensureLocalKey, readLocalKey, withStoreLock } from "./envStore";
import { mkdirSecure } from "./secretFile";

const FILE = "secrets.sealed";
const storePath = (): string => join(joyHomeDir(), FILE);

interface Entry { name: string; value: string; at: number }
/** session id → lower-cased name → entry. Prototype-free at both levels: a
 *  name like `__proto__` must be stored, not swallowed by a setter. */
type Store = Record<string, Record<string, Entry>>;
const dict = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
export function isValidSecretName(name: string): boolean { return NAME_RE.test(name); }
const SESSION_RE = /^[0-9a-f]{8}$/;
/** A value is at most 64 KiB and carries no NUL (the environment cannot). */
export function isValidSecretValue(v: unknown): v is string { return typeof v === "string" && v.length > 0 && v.length <= 65536 && !v.includes("\0"); }

function seal(store: Store, key: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ v: 1, sessions: store }), "utf8")), cipher.final()]);
  return Buffer.concat([Buffer.from([0]), nonce, enc, cipher.getAuthTag()]).toString("base64");
}

function open(b64: string, key: Uint8Array): Store | null {
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 1 + 12 + 16 || buf[0] !== 0) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", key, buf.subarray(1, 13));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const parsed = JSON.parse(Buffer.concat([d.update(buf.subarray(13, buf.length - 16)), d.final()]).toString("utf8")) as { sessions?: unknown };
    const out: Store = dict();
    const sessions = parsed?.sessions;
    if (!sessions || typeof sessions !== "object") return out;
    for (const [sid, entries] of Object.entries(sessions as Record<string, unknown>)) {
      if (!entries || typeof entries !== "object") continue;
      const m = dict<Entry>();
      for (const [k, e] of Object.entries(entries as Record<string, Partial<Entry>>)) {
        if (e && typeof e.name === "string" && isValidSecretValue(e.value)) m[k] = { name: e.name, value: e.value, at: typeof e.at === "number" ? e.at : 0 };
      }
      out[sid] = m;
    }
    return out;
  } catch { return null; }
}

type Read = { ok: true; store: Store } | { ok: false; error: string };

function readStore(): Read {
  if (!existsSync(storePath())) return { ok: true, store: dict() };
  const key = readLocalKey();
  if (!key) return { ok: false, error: "store_unreadable" };
  try {
    const store = open(readFileSync(storePath(), "utf8").trim(), key);
    return store ? { ok: true, store } : { ok: false, error: "store_unreadable" };
  } catch { return { ok: false, error: "store_unreadable" }; }
}

function writeStore(store: Store): void {
  for (const sid of Object.keys(store)) if (Object.keys(store[sid]).length === 0) delete store[sid];
  const key = ensureLocalKey();
  mkdirSecure(joyHomeDir());
  const tmp = `${storePath()}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, seal(store, key) + "\n", { mode: 0o600 });
    renameSync(tmp, storePath());
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never written */ }
    throw e;
  }
  cache = null;
}

/** One read-modify-write under the env store's lock. */
function update<T extends object>(fn: (store: Store) => T): T | { ok: false; error: string } {
  return withStoreLock(() => {
    const cur = readStore();
    if (!cur.ok) return cur;
    const out = fn(cur.store);
    writeStore(cur.store);
    return out;
  });
}

const badSession = { ok: false as const, error: "bad_session" };

export function listSecrets(sessionId: string): { ok: true; secrets: Array<{ name: string; at: number }> } | { ok: false; error: string } {
  if (!SESSION_RE.test(sessionId)) return badSession;
  const cur = readStore();
  if (!cur.ok) return cur;
  const entries = Object.values(cur.store[sessionId] ?? {});
  return { ok: true, secrets: entries.map(({ name, at }) => ({ name, at })).sort((a, b) => a.name.localeCompare(b.name)) };
}

/** Add or replace several at once. All-or-nothing: one bad name or value
 *  refuses the whole set, so a half-saved form never happens. */
export function setSecrets(sessionId: string, pairs: Record<string, unknown>): { ok: true; names: string[] } | { ok: false; error: string; name?: string } {
  if (!SESSION_RE.test(sessionId)) return badSession;
  const names = Object.keys(pairs);
  if (names.length === 0) return { ok: false, error: "no_secrets" };
  for (const n of names) {
    if (!isValidSecretName(n)) return { ok: false, error: "bad_name", name: n };
    if (!isValidSecretValue(pairs[n])) return { ok: false, error: "bad_value", name: n };
  }
  const at = Date.now();
  return update((store) => {
    const m = store[sessionId] ?? (store[sessionId] = dict<Entry>());
    for (const n of names) m[n.toLowerCase()] = { name: n, value: pairs[n] as string, at };
    return { ok: true as const, names };
  });
}

export function getSecret(sessionId: string, name: string): { ok: true; name: string; value: string } | { ok: false; error: string } {
  if (!SESSION_RE.test(sessionId)) return badSession;
  const cur = readStore();
  if (!cur.ok) return cur;
  const e = cur.store[sessionId]?.[name.toLowerCase()];
  return e ? { ok: true, name: e.name, value: e.value } : { ok: false, error: "not_found" };
}

export function removeSecret(sessionId: string, name: string): { ok: true; existed: boolean } | { ok: false; error: string } {
  if (!SESSION_RE.test(sessionId)) return badSession;
  return update((store) => {
    const m = store[sessionId];
    const k = name.toLowerCase();
    const existed = !!m && Object.hasOwn(m, k);
    if (existed) delete m[k];
    return { ok: true as const, existed };
  });
}

/** Forget every secret of a session (it was killed). Quiet when it had none. */
export function dropSessionSecrets(sessionId: string): void {
  if (!SESSION_RE.test(sessionId)) return;
  const cur = readStore();
  if (!cur.ok || !cur.store[sessionId]) return;
  try { update((store) => { delete store[sessionId]; return {}; }); } catch { /* best effort */ }
}

/** Give a fork or handoff target the secrets its source had. */
export function copySessionSecrets(from: string, to: string): void {
  if (!SESSION_RE.test(from) || !SESSION_RE.test(to) || from === to) return;
  const cur = readStore();
  if (!cur.ok || !cur.store[from]) return;
  try {
    update((store) => {
      const src = store[from];
      if (!src) return {};
      const dst = store[to] ?? (store[to] = dict<Entry>());
      for (const [k, e] of Object.entries(src)) dst[k] = { ...e };
      return {};
    });
  } catch { /* best effort */ }
}

// ── redaction ────────────────────────────────────────────────────────────────
// Every record an agent emits passes through redactSecrets on its way to the
// relay, so a value the agent read with `joy secret get` and then echoed is
// blanked in the app's chat. The decoded store is cached against the file's
// mtime: this runs on every record, and the file changes only on a write.

/** Values this short would blank ordinary words; they are left alone. */
const MIN_REDACT_LENGTH = 4;
export const REDACTED = "••••••";
let cache: { mtimeMs: number; store: Store } | null = null;

function cachedStore(): Store | null {
  let mtimeMs: number;
  try { mtimeMs = statSync(storePath()).mtimeMs; } catch { cache = null; return null; }
  if (cache && cache.mtimeMs === mtimeMs) return cache.store;
  const cur = readStore();
  if (!cur.ok) return null;
  cache = { mtimeMs, store: cur.store };
  return cur.store;
}

/** The values to blank in a session's output, longest first so a value that
 *  contains another is replaced whole. */
export function secretValuesFor(sessionId: string): string[] {
  const m = cachedStore()?.[sessionId];
  if (!m) return [];
  return Object.values(m).map((e) => e.value).filter((v) => v.length >= MIN_REDACT_LENGTH).sort((a, b) => b.length - a.length);
}

/** Replace every secret value of the session found in `text`. */
export function redactText(text: string, values: string[]): string {
  let out = text;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(REDACTED);
  return out;
}

/** A record with every secret value of its session blanked, or the same
 *  object when there is nothing to blank (the common case costs one stat). */
export function redactSecrets<T>(sessionId: string, record: T): T {
  const values = secretValuesFor(sessionId);
  if (values.length === 0) return record;
  const json = JSON.stringify(record);
  // A value as it appears INSIDE a JSON string: quotes, backslashes and
  // newlines are escaped there, so the raw value would never match.
  const encoded = values.map((v) => JSON.stringify(v).slice(1, -1));
  const blanked = redactText(json, encoded);
  return blanked === json ? record : JSON.parse(blanked) as T;
}
