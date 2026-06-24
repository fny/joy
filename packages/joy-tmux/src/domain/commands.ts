// Slash-command discovery for the app's "/" menu + machine page.
//
// joy-tmux runs the bare `claude` CLI (no Agent SDK), so unlike happy-cli it
// has no built-in channel telling the app which slash commands exist. We
// discover them from the filesystem instead — the names only, since the app's
// suggestion list (sync/suggestionCommands.ts) keys off names and supplies its
// own descriptions.
//
// Sources (all best-effort; a missing/unreadable dir is just empty):
//   <cwd>/.claude/commands/**.md        project commands   (sub/ → `sub:name`)
//   <cwd>/.claude/skills/<name>/SKILL.md project skills
//   ~/.claude/commands, ~/.claude/skills personal (machine-wide)
//   ~/.claude/plugins/marketplaces/*/plugins/<p>/{commands,skills}  → `p:name`
//
// A session is a *projection* of the machine registry: its list is
// (machine ∪ its project). The machine page shows the union across everything
// the daemon has seen (personal ∪ plugins ∪ every scanned project), so a
// command stays known even after you leave that project's session.

import { readdirSync, statSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { RelayClient, RelaySession } from "../relay/relay.ts";

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/**
 * `*.md` files in a commands dir become command names (filename without `.md`).
 * One level of subdirectories namespaces them as `subdir:name`, matching
 * Claude Code's project-command namespacing.
 */
export function scanCommandsDir(dir: string): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const p = join(dir, entry);
    if (entry.endsWith(".md")) {
      out.push(entry.slice(0, -3));
    } else if (isDir(p)) {
      for (const sub of safeReaddir(p)) {
        if (sub.endsWith(".md")) out.push(`${entry}:${sub.slice(0, -3)}`);
      }
    }
  }
  return out;
}

/** Each subdir holding a SKILL.md is a skill; its name is the frontmatter
 *  `name:` (canonical), falling back to the directory name. */
export function scanSkillsDir(dir: string): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const manifest = join(dir, entry, "SKILL.md");
    if (existsSync(manifest)) out.push(skillName(manifest, entry));
  }
  return out;
}

function skillName(manifestPath: string, fallback: string): string {
  try {
    const text = readFileSync(manifestPath, "utf8");
    const fm = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (fm) {
      const nm = fm[1].match(/^\s*name:\s*(.+?)\s*$/m);
      if (nm) {
        const name = nm[1].replace(/^["']|["']$/g, "").trim();
        if (name) return name;
      }
    }
  } catch { /* fall through to dir name */ }
  return fallback;
}

/** Installed plugin commands/skills: `<plugin>:<name>`. Best-effort over the
 *  marketplace tree; structure drift just yields fewer entries. */
export function scanPluginCommands(pluginsDir: string): string[] {
  const out: string[] = [];
  const marketplaces = join(pluginsDir, "marketplaces");
  for (const mkt of safeReaddir(marketplaces)) {
    const pluginsRoot = join(marketplaces, mkt, "plugins");
    for (const plugin of safeReaddir(pluginsRoot)) {
      for (const cmd of scanCommandsDir(join(pluginsRoot, plugin, "commands"))) {
        out.push(`${plugin}:${cmd}`);
      }
      for (const skill of scanSkillsDir(join(pluginsRoot, plugin, "skills"))) {
        out.push(`${plugin}:${skill}`);
      }
    }
  }
  return out;
}

function dedupeSorted(names: string[]): string[] {
  return [...new Set(names)].sort();
}

/** Project-scoped commands + skills under `<cwd>/.claude`. */
export function scanProject(cwd: string): string[] {
  const base = join(cwd, ".claude");
  return dedupeSorted([...scanCommandsDir(join(base, "commands")), ...scanSkillsDir(join(base, "skills"))]);
}

/** Machine-wide commands: personal `~/.claude` + installed plugins. */
export function scanMachine(home: string): string[] {
  const base = join(home, ".claude");
  return dedupeSorted([
    ...scanCommandsDir(join(base, "commands")),
    ...scanSkillsDir(join(base, "skills")),
    ...scanPluginCommands(join(base, "plugins")),
  ]);
}

export interface CommandRegistryOpts {
  relayClient: RelayClient | null;
  /** The machine-metadata blob server.ts upserts; we re-send it (full-blob
   *  upsert) with `slashCommands` added, preserving its other fields. */
  baseMachineMetadata: Record<string, unknown>;
  homeDir?: string;
}

/**
 * Daemon-level source of truth for slash commands. Holds the machine-wide set
 * (personal + plugins) plus a per-cwd map accumulated from session scans, and
 * mirrors the union into machine metadata (idempotently — only on change).
 */
export class CommandRegistry {
  readonly #relay: RelayClient | null;
  readonly #base: Record<string, unknown>;
  readonly #home: string;
  #machine = new Set<string>();
  #projects = new Map<string, Set<string>>();
  #lastPushed: string | null = null;
  // Serializes machine-metadata upserts so concurrent callers (boot, periodic
  // rescan, per-session attach) can't land out of order and leave a stale union.
  #pushChain: Promise<void> = Promise.resolve();

  constructor(opts: CommandRegistryOpts) {
    this.#relay = opts.relayClient;
    this.#base = opts.baseMachineMetadata;
    this.#home = opts.homeDir ?? homedir();
  }

  rescanMachine(): void {
    this.#machine = new Set(scanMachine(this.#home));
  }

  setProject(cwd: string, names: string[]): void {
    this.#projects.set(cwd, new Set(names));
  }

  /** The list for one session = machine ∪ that project. */
  forProject(cwd: string): string[] {
    const s = new Set(this.#machine);
    for (const n of this.#projects.get(cwd) ?? []) s.add(n);
    return [...s].sort();
  }

  /** Everything the daemon knows = machine ∪ all scanned projects. */
  union(): string[] {
    const s = new Set(this.#machine);
    for (const set of this.#projects.values()) for (const n of set) s.add(n);
    return [...s].sort();
  }

  /** Re-upsert machine metadata with the union, only when it actually changed.
   *  Serialized via #pushChain; the union is re-read inside the critical section
   *  so the latest set always wins, and #lastPushed advances only on success. */
  async pushMachineIfChanged(): Promise<void> {
    const relay = this.#relay;
    if (!relay) return;
    if (this.union().join("\n") === this.#lastPushed) return;
    this.#pushChain = this.#pushChain.then(async () => {
      const union = this.union();
      const key = union.join("\n");
      if (key === this.#lastPushed) return;
      const ok = await relay.getOrCreateMachine({ ...this.#base, slashCommands: union });
      if (ok) this.#lastPushed = key;
    });
    return this.#pushChain;
  }

  /** On relay attach (launch / recover / reconnect): scan this session's
   *  project, push its list, and fold the project into machine knowledge. */
  async onSessionAttached(cwd: string, rs: RelaySession): Promise<void> {
    this.setProject(cwd, scanProject(cwd));
    try { await rs.updateSlashCommands(this.forProject(cwd)); } catch { /* best-effort */ }
    await this.pushMachineIfChanged();
  }

  /** Machine-page refresh: rescan machine + re-validate every known project
   *  (a project whose commands were removed drops out), then push + return. */
  refresh(): { slashCommands: string[] } {
    this.rescanMachine();
    for (const cwd of [...this.#projects.keys()]) this.setProject(cwd, scanProject(cwd));
    void this.pushMachineIfChanged();
    return { slashCommands: this.union() };
  }
}
