// Per-agent config-file editing, driven from the app (joy-agent-config-* ops).
// Three modes compose from the same primitives:
//   read   — raw text + parsed doc (when parseable)
//   set    — JSON-path assignment lines (`examples[0].title = "hi"`) merged
//            into the parsed doc and written back; the file's other keys are
//            untouched (this is the "merge/append" the raw editor can't give)
//   write  — full raw replacement, validated as parseable first
// Every write backs up the previous file next to it (<name>.joy-bak) — one
// generation, enough to undo the last edit by hand.
//
// Schemas: claude + opencode publish JSON Schemas; the daemon fetches and
// caches them (memory + ~/.joy/schema-cache) so the app can render a
// schema-walked editor. codex/pi have no published schema — raw + path modes
// still work.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { joyStateDir } from "../paths";
import { writeFileAtomic } from "./atomicWrite";
import { codexConfigPath } from "../codex/codexHome";

export type ConfigAgent = "claude" | "codex" | "opencode" | "pi" | "agy";

interface AgentConfigSpec {
  path: string;
  format: "json" | "toml";
  schemaUrl: string | null;
}

// Paths resolve at CALL time (not import time) so tests can retarget HOME.
function specs(): Record<ConfigAgent, AgentConfigSpec> {
  return {
    claude: { path: join(homedir(), ".claude", "settings.json"), format: "json", schemaUrl: "https://json.schemastore.org/claude-code-settings.json" },
    // Under $CODEX_HOME when set — the file the running codex actually reads (#524).
    codex: { path: codexConfigPath(), format: "toml", schemaUrl: null },
    opencode: { path: join(homedir(), ".config", "opencode", "opencode.json"), format: "json", schemaUrl: "https://opencode.ai/config.json" },
    pi: { path: join(homedir(), ".pi", "agent", "settings.json"), format: "json", schemaUrl: null },
    agy: { path: join(homedir(), ".gemini", "antigravity-cli", "settings.json"), format: "json", schemaUrl: null },
  };
}

export function agentConfigSpec(agent: string): AgentConfigSpec | null {
  return (specs() as Record<string, AgentConfigSpec>)[agent] ?? null;
}

function parseDoc(format: "json" | "toml", raw: string): Record<string, unknown> {
  const doc = format === "json" ? JSON.parse(raw) : parseToml(raw);
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) throw new Error("config root is not an object");
  return doc as Record<string, unknown>;
}

function stringifyDoc(format: "json" | "toml", doc: Record<string, unknown>): string {
  return format === "json" ? JSON.stringify(doc, null, 2) + "\n" : stringifyToml(doc) + "\n";
}

export function readAgentConfig(agent: string): { ok: true; agent: string; path: string; format: string; exists: boolean; raw: string; parsed: unknown | null; parseError: string | null } | { ok: false; error: string } {
  const spec = agentConfigSpec(agent);
  if (!spec) return { ok: false, error: `unknown agent "${agent}"` };
  if (!existsSync(spec.path)) {
    return { ok: true, agent, path: spec.path, format: spec.format, exists: false, raw: "", parsed: null, parseError: null };
  }
  const raw = readFileSync(spec.path, "utf-8");
  try {
    return { ok: true, agent, path: spec.path, format: spec.format, exists: true, raw, parsed: parseDoc(spec.format, raw), parseError: null };
  } catch (e) {
    return { ok: true, agent, path: spec.path, format: spec.format, exists: true, raw, parsed: null, parseError: String(e) };
  }
}

// Segments that walk off the document onto shared prototypes: an assignment
// `__proto__.x = 1` made `node = Object.prototype` and polluted every object
// in the daemon process until restart (#54). Refused at parse time; setAtPath
// additionally descends only through OWN properties.
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

/** The largest real array index (2^32−2). Above it an assignment silently
 *  becomes a string property, which JSON serialization drops (#525). */
const MAX_ARRAY_INDEX = 0xfffffffe;

/** `examples[0].title` → ["examples", 0, "title"]. Dots and [n] only — quoted
 *  keys aren't supported (none of the agent configs need them).
 *
 *  The whole expression is parsed against an ANCHORED grammar (#525):
 *  `key ( "." key | "[" digits "]" )*`. The old regex scan skipped anything
 *  it did not recognise, so `examples[-1].title` became the string property
 *  "-1" on an array — a write JSON serialization drops — and the op reported
 *  `ok:true, applied:1` while the file was unchanged. Unmatched brackets,
 *  negative/blank indices, empty segments and stray separators are errors. */
export function parsePathExpr(expr: string): Array<string | number> {
  const out: Array<string | number> = [];
  const bad = (why: string): never => { throw new Error(`bad path: "${expr}" (${why})`); };
  const key = (k: string): string => {
    if (!k) bad("empty key");
    if (FORBIDDEN_SEGMENTS.has(k)) bad(`"${k}" is not an allowed key`);
    return k;
  };
  let i = 0;
  const readKey = (): string => {
    const start = i;
    while (i < expr.length && expr[i] !== "." && expr[i] !== "[" && expr[i] !== "]") i++;
    return key(expr.slice(start, i));
  };
  out.push(readKey());
  while (i < expr.length) {
    const c = expr[i];
    if (c === ".") { i++; out.push(readKey()); continue; }
    if (c === "[") {
      const close = expr.indexOf("]", i);
      if (close < 0) bad("unmatched \"[\"");
      const idx = expr.slice(i + 1, close);
      if (!/^\d+$/.test(idx)) bad(`index "[${idx}]" must be a non-negative integer`);
      // Range, not just shape (#525 residual, Astra on 4a69e55c): `[4294967295]`
      // is a well-formed non-negative integer but not an ARRAY index — the
      // maximum is 2^32−2, and above it `arr[n] = v` writes an ordinary string
      // property that JSON.stringify drops, so the op reported ok:true /
      // applied:1 over an unchanged file. Anything past Number.MAX_SAFE_INTEGER
      // also stops round-tripping through Number() at all.
      const n = Number(idx);
      if (!Number.isSafeInteger(n) || n > MAX_ARRAY_INDEX) bad(`index "[${idx}]" is out of range (max ${MAX_ARRAY_INDEX})`);
      out.push(n);
      i = close + 1;
      continue;
    }
    bad(`unexpected "${c}"`);
  }
  return out;
}

/** One assignment line: `path.to[2].key = <value>`. Value is JSON when it
 *  parses (true, 3, "x", [..], {..}, null deletes the key), bare text
 *  otherwise. */
export function parseAssignment(line: string): { path: Array<string | number>; value: unknown; del: boolean } {
  const eq = line.indexOf("=");
  if (eq < 1) throw new Error(`not an assignment: "${line}" (expected: path.to.key = value)`);
  const pathExpr = line.slice(0, eq).trim();
  const valueExpr = line.slice(eq + 1).trim();
  let value: unknown;
  try {
    value = JSON.parse(valueExpr);
  } catch {
    value = valueExpr; // bare word/string
  }
  return { path: parsePathExpr(pathExpr), value, del: value === null };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Apply one assignment to the parsed doc. Returns whether the doc changed.
 *
 *  Traversal is type-checked against the ACTUAL document (#525): a numeric
 *  index into an object or a string key into an array is an error, not a
 *  silent property write. Descent reads OWN properties only (#54).
 *
 *  Deletion is lookup-only (#526): the old code ran the same auto-vivifying
 *  walk for `= null`, so deleting `important.missing` first REPLACED the
 *  scalar `important: "original"` with `{}` and then deleted nothing — the
 *  op reported success and an unrelated value was gone. Now a delete whose
 *  parent or target is absent leaves the document untouched, and a parent of
 *  the wrong type is rejected. */
function setAtPath(doc: Record<string, unknown>, path: Array<string | number>, value: unknown, del: boolean): boolean {
  const describe = (i: number) => path.slice(0, i + 1).map((k) => (typeof k === "number" ? `[${k}]` : `.${k}`)).join("").replace(/^\./, "");
  const childOf = (node: unknown, key: string | number, i: number): unknown => {
    if (Array.isArray(node)) {
      if (typeof key !== "number") throw new Error(`path type mismatch: ${describe(i - 1)} is an array; "${key}" is not an index`);
      return node[key];
    }
    if (isObj(node)) {
      if (typeof key === "number") throw new Error(`path type mismatch: ${describe(i - 1)} is an object; [${key}] is not a key`);
      return Object.hasOwn(node, key) ? node[key] : undefined;
    }
    return undefined;
  };
  /** An index may address an existing element or APPEND at the end; a gap
   *  past the end is refused (#525 residual). Writing `examples[9]` into a
   *  one-element array is not the edit anyone means — it would either grow
   *  the file by eight `null`s or, past 2^32−2, be dropped entirely and
   *  reported as applied. */
  const checkIndex = (arr: unknown[], idx: number, i: number): void => {
    if (idx > arr.length) throw new Error(`index out of range: ${describe(i)} — the array has ${arr.length} element(s), so [${idx}] would leave a gap (append at [${arr.length}])`);
  };
  let node: unknown = doc;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (Array.isArray(node) && typeof key === "number") checkIndex(node, key, i);
    let child = childOf(node, key, i);
    if (child === undefined || typeof child !== "object" || child === null) {
      if (del) return false; // nothing to delete beneath a missing/scalar parent — leave the doc alone
      // Auto-vivify (or replace a scalar) on the way to a SET: the caller
      // asked for a nested key, so a container is what they mean.
      child = typeof nextKey === "number" ? [] : {};
      (node as any)[key] = child;
    }
    node = child;
  }
  const last = path[path.length - 1];
  const parentIdx = path.length - 2;
  if (Array.isArray(node)) {
    if (typeof last !== "number") throw new Error(`path type mismatch: ${describe(parentIdx)} is an array; "${last}" is not an index`);
    if (del) { if (last >= node.length) return false; node.splice(last, 1); return true; }
    checkIndex(node, last, path.length - 1);
    node[last] = value;
    return true;
  }
  if (!isObj(node)) throw new Error(`path type mismatch: ${describe(parentIdx)} is not a container`);
  if (typeof last === "number") throw new Error(`path type mismatch: ${describe(parentIdx)} is an object; [${last}] is not a key`);
  if (del) { if (!Object.hasOwn(node, last)) return false; delete node[last]; return true; }
  node[last] = value;
  return true;
}

/** Replace the config atomically and rotate <name>.joy-bak as part of the
 *  SAME successful replacement. The previous shape — copy live → backup, then
 *  writeFileSync — meant an ENOSPC after the truncating write left a partial
 *  live file, and the user's RETRY copied that partial file over the only
 *  intact backup: two failed saves = both copies gone (#527). writeFileAtomic
 *  stages the new contents beside the file, never truncates the live one, and
 *  rotates the backup only once the rename has landed. */
function backupThenWrite(path: string, content: string): void {
  writeFileAtomic(path, content, { backup: path + ".joy-bak" });
}

export function applyAgentConfigAssignments(agent: string, lines: string[]): { ok: true; raw: string; applied: number } | { ok: false; error: string } {
  const spec = agentConfigSpec(agent);
  if (!spec) return { ok: false, error: `unknown agent "${agent}"` };
  let doc: Record<string, unknown> = {};
  if (existsSync(spec.path)) {
    try {
      doc = parseDoc(spec.format, readFileSync(spec.path, "utf-8"));
    } catch (e) {
      // Never merge into a file we can't parse — a rewrite would eat the
      // user's (possibly hand-broken but recoverable) content.
      return { ok: false, error: `existing config does not parse (${e}) — fix it in raw mode first` };
    }
  }
  let applied = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const { path, value, del } = parseAssignment(line);
      // A no-op delete (#526) is accepted but not counted: `applied` says how
      // many lines CHANGED the document.
      if (setAtPath(doc, path, value, del)) applied++;
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
  const raw = stringifyDoc(spec.format, doc);
  try {
    backupThenWrite(spec.path, raw);
  } catch (e) {
    return { ok: false, error: `write failed: ${e}` };
  }
  return { ok: true, raw, applied };
}

export function writeAgentConfigRaw(agent: string, raw: string): { ok: true } | { ok: false; error: string } {
  const spec = agentConfigSpec(agent);
  if (!spec) return { ok: false, error: `unknown agent "${agent}"` };
  try {
    parseDoc(spec.format, raw); // refuse to save something the agent can't read
  } catch (e) {
    return { ok: false, error: `does not parse as ${spec.format}: ${e}` };
  }
  try {
    backupThenWrite(spec.path, raw.endsWith("\n") ? raw : raw + "\n");
  } catch (e) {
    return { ok: false, error: `write failed: ${e}` };
  }
  return { ok: true };
}

// ── schema fetch + cache ─────────────────────────────────────────────────────

const schemaMem = new Map<string, unknown>();

export async function fetchAgentSchema(agent: string): Promise<{ ok: true; schema: unknown } | { ok: false; error: string }> {
  const spec = agentConfigSpec(agent);
  if (!spec) return { ok: false, error: `unknown agent "${agent}"` };
  if (!spec.schemaUrl) return { ok: false, error: `no published schema for ${agent}` };
  if (schemaMem.has(agent)) return { ok: true, schema: schemaMem.get(agent) };
  const cacheFile = join(joyStateDir(), "schema-cache", `${agent}.json`);
  try {
    const res = await fetch(spec.schemaUrl, { signal: AbortSignal.timeout(15_000), headers: { "Accept": "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const schema = await res.json();
    schemaMem.set(agent, schema);
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(schema));
    } catch { /* cache write is best-effort */ }
    return { ok: true, schema };
  } catch (e) {
    // Offline: serve the last fetched copy if we have one.
    try {
      const schema = JSON.parse(readFileSync(cacheFile, "utf-8"));
      schemaMem.set(agent, schema);
      return { ok: true, schema };
    } catch {
      return { ok: false, error: `schema fetch failed: ${e}` };
    }
  }
}
