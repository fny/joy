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

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { joyStateDir } from "../paths";

export type ConfigAgent = "claude" | "codex" | "opencode" | "pi";

interface AgentConfigSpec {
  path: string;
  format: "json" | "toml";
  schemaUrl: string | null;
}

// Paths resolve at CALL time (not import time) so tests can retarget HOME.
function specs(): Record<ConfigAgent, AgentConfigSpec> {
  return {
    claude: { path: join(homedir(), ".claude", "settings.json"), format: "json", schemaUrl: "https://json.schemastore.org/claude-code-settings.json" },
    codex: { path: join(homedir(), ".codex", "config.toml"), format: "toml", schemaUrl: null },
    opencode: { path: join(homedir(), ".config", "opencode", "opencode.json"), format: "json", schemaUrl: "https://opencode.ai/config.json" },
    pi: { path: join(homedir(), ".pi", "agent", "settings.json"), format: "json", schemaUrl: null },
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

/** `examples[0].title` → ["examples", 0, "title"]. Dots and [n] only — quoted
 *  keys aren't supported (none of the agent configs need them). */
export function parsePathExpr(expr: string): Array<string | number> {
  const out: Array<string | number> = [];
  const re = /([^.[\]]+)|\[(\d+)\]/g;
  let m: RegExpExecArray | null;
  let consumed = 0;
  while ((m = re.exec(expr)) !== null) {
    consumed = re.lastIndex;
    out.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  }
  if (out.length === 0 || consumed !== expr.length && expr.slice(consumed).replace(/\./g, "").length > 0) {
    if (out.length === 0) throw new Error(`bad path: "${expr}"`);
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

function setAtPath(doc: Record<string, unknown>, path: Array<string | number>, value: unknown, del: boolean): void {
  let node: any = doc;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextKey = path[i + 1];
    if (node[key] == null || typeof node[key] !== "object") {
      node[key] = typeof nextKey === "number" ? [] : {};
    }
    node = node[key];
  }
  const last = path[path.length - 1];
  if (del) {
    if (Array.isArray(node) && typeof last === "number") node.splice(last, 1);
    else delete node[last];
  } else {
    node[last] = value;
  }
}

function backupThenWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (existsSync(path)) copyFileSync(path, path + ".joy-bak");
  writeFileSync(path, content);
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
      setAtPath(doc, path, value, del);
      applied++;
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
