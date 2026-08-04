// Slash-command discovery for the app's "/" menu + machine page.
//
// joy-tmux runs the bare `claude` CLI (no Agent SDK), so unlike happy-cli it
// has no built-in channel telling the app which slash commands exist. We
// discover them from the filesystem instead — the names only, since the app's
// suggestion list (sync/suggestionCommands.ts) keys off names and supplies its
// own descriptions.
//
// Sources (all best-effort; a missing/unreadable dir is just empty).
// Conventions verified against vendor docs 2026-08-04:
//   claude:   <cwd>/.claude/commands/**.md (sub/ → `sub:name`),
//             <cwd>/.claude/skills/<name>/SKILL.md; personal ~/.claude/{commands,skills};
//             plugins marketplaces → `p:name` (machine scan excludes them — noise)
//   codex:    <cwd>/.codex/skills; personal ~/.codex/skills (dot-dirs like
//             .system are naturally skipped — no direct SKILL.md) and
//             ~/.codex/prompts/*.md (TOP-LEVEL only; codex ignores subdirs)
//   opencode: <cwd>/.opencode/{commands,skills}; personal
//             ~/.config/opencode/{commands,skills}
//   cross-agent standard (read by codex AND opencode): <cwd>/.agents/skills;
//             personal ~/.agents/skills
// Limitation: codex/opencode walk .agents/skills from cwd UP to the repo root;
// we scan the session cwd only (joy sessions overwhelmingly launch at root).
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

/** A discovered slash command: its (possibly namespaced) name plus the
 *  `description:` from the source `.md` frontmatter, when present. */
export interface ScannedCommand {
  name: string;
  description?: string;
}

/** Read a single-line field from a markdown file's YAML frontmatter, e.g.
 *  `description: ...` or `name: ...`. Returns undefined if absent/unreadable. */
function readFrontmatterField(path: string, field: string): string | undefined {
  try {
    const text = readFileSync(path, "utf8");
    const fm = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return undefined;
    const m = fm[1].match(new RegExp(`^\\s*${field}:\\s*(.+?)\\s*$`, "m"));
    if (!m) return undefined;
    const v = m[1].replace(/^["']|["']$/g, "").trim();
    return v || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `*.md` files in a commands dir become command names (filename without `.md`),
 * carrying their frontmatter `description:` when present. One level of
 * subdirectories namespaces them as `subdir:name`, matching Claude Code's
 * project-command namespacing.
 */
export function scanCommandsDir(dir: string, opts?: { topLevelOnly?: boolean }): ScannedCommand[] {
  const out: ScannedCommand[] = [];
  for (const entry of safeReaddir(dir)) {
    const p = join(dir, entry);
    if (entry.endsWith(".md")) {
      out.push({ name: entry.slice(0, -3), description: readFrontmatterField(p, "description") });
    } else if (!opts?.topLevelOnly && isDir(p)) {
      for (const sub of safeReaddir(p)) {
        if (sub.endsWith(".md")) {
          out.push({ name: `${entry}:${sub.slice(0, -3)}`, description: readFrontmatterField(join(p, sub), "description") });
        }
      }
    }
  }
  return out;
}

/** Each subdir holding a SKILL.md is a skill; its name is the frontmatter
 *  `name:` (canonical), falling back to the directory name, plus the skill's
 *  `description:`. */
export function scanSkillsDir(dir: string): ScannedCommand[] {
  const out: ScannedCommand[] = [];
  for (const entry of safeReaddir(dir)) {
    const manifest = join(dir, entry, "SKILL.md");
    if (existsSync(manifest)) {
      out.push({
        name: readFrontmatterField(manifest, "name") ?? entry,
        description: readFrontmatterField(manifest, "description"),
      });
    }
  }
  return out;
}

/** Installed plugin commands/skills: `<plugin>:<name>`. Best-effort over the
 *  marketplace tree; structure drift just yields fewer entries. */
export function scanPluginCommands(pluginsDir: string): ScannedCommand[] {
  const out: ScannedCommand[] = [];
  const marketplaces = join(pluginsDir, "marketplaces");
  for (const mkt of safeReaddir(marketplaces)) {
    const pluginsRoot = join(marketplaces, mkt, "plugins");
    for (const plugin of safeReaddir(pluginsRoot)) {
      for (const c of scanCommandsDir(join(pluginsRoot, plugin, "commands"))) {
        out.push({ name: `${plugin}:${c.name}`, description: c.description });
      }
      for (const s of scanSkillsDir(join(pluginsRoot, plugin, "skills"))) {
        out.push({ name: `${plugin}:${s.name}`, description: s.description });
      }
    }
  }
  return out;
}

/** Dedupe by name (keeping a description if any dup carries one) and sort. */
function dedupeSorted(cmds: ScannedCommand[]): ScannedCommand[] {
  const byName = new Map<string, ScannedCommand>();
  for (const c of cmds) {
    const prev = byName.get(c.name);
    if (!prev || (!prev.description && c.description)) byName.set(c.name, c);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Project-scoped commands + skills across every agent convention. */
export function scanProject(cwd: string): ScannedCommand[] {
  return dedupeSorted([
    ...scanCommandsDir(join(cwd, ".claude", "commands")),
    ...scanSkillsDir(join(cwd, ".claude", "skills")),
    ...scanSkillsDir(join(cwd, ".codex", "skills")),
    ...scanCommandsDir(join(cwd, ".opencode", "commands")),
    ...scanSkillsDir(join(cwd, ".opencode", "skills")),
    ...scanSkillsDir(join(cwd, ".agents", "skills")),
  ]);
}

/** Machine-wide commands: personal `~/.claude` only. Plugin commands
 *  (marketplaces/<m>/plugins/<p>) are deliberately EXCLUDED — they flooded
 *  the app's "/" autocomplete with noise (claude-code-setup, example-plugin,
 *  …) the user never invokes from chat ("I don't want any plugins"). */
export function scanMachine(home: string): ScannedCommand[] {
  return dedupeSorted([
    ...scanCommandsDir(join(home, ".claude", "commands")),
    ...scanSkillsDir(join(home, ".claude", "skills")),
    // codex custom prompts are top-level-only by codex's own scan rules.
    ...scanCommandsDir(join(home, ".codex", "prompts"), { topLevelOnly: true }),
    ...scanSkillsDir(join(home, ".codex", "skills")),
    ...scanCommandsDir(join(home, ".config", "opencode", "commands")),
    ...scanSkillsDir(join(home, ".config", "opencode", "skills")),
    ...scanSkillsDir(join(home, ".agents", "skills")),
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
  // Plugin-only subset of #machine, exposed separately so the app can
  // include/exclude plugin commands (they share the `name:name` shape with
  // project-subfolder commands, so the app can't tell them apart by name).
  #plugins = new Set<string>();
  #projects = new Map<string, Set<string>>();
  // name → frontmatter description, accumulated across machine + every scanned
  // project (union; never shrinks, stale entries are filtered out on push).
  #descriptions = new Map<string, string>();
  #lastPushed: string | null = null;
  // Serializes machine-metadata upserts so concurrent callers (boot, periodic
  // rescan, per-session attach) can't land out of order and leave a stale union.
  #pushChain: Promise<void> = Promise.resolve();

  constructor(opts: CommandRegistryOpts) {
    this.#relay = opts.relayClient;
    this.#base = opts.baseMachineMetadata;
    this.#home = opts.homeDir ?? homedir();
  }

  #mergeDescriptions(cmds: ScannedCommand[]): void {
    for (const c of cmds) {
      if (c.description) this.#descriptions.set(c.name, c.description);
    }
  }

  rescanMachine(): void {
    const machine = scanMachine(this.#home);
    this.#machine = new Set(machine.map((c) => c.name));
    this.#plugins = new Set(); // plugin commands excluded from autocomplete entirely (see scanMachine)
    this.#mergeDescriptions(machine);
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
  /** union + plugin subset + descriptions for currently-known commands (stale
   *  entries filtered out), plus a string key for change detection. */
  #snapshot(): { union: string[]; plugins: string[]; descriptions: Record<string, string>; key: string } {
    const union = this.union();
    const plugins = [...this.#plugins].sort();
    const names = new Set(union);
    const descriptions = Object.fromEntries(
      [...this.#descriptions].filter(([name]) => names.has(name)).sort((a, b) => a[0].localeCompare(b[0])),
    );
    const key = union.join("\n") + "\u0000" + plugins.join("\n") + "\u0000" +
      Object.entries(descriptions).map(([k, v]) => `${k}=${v}`).join("\n");
    return { union, plugins, descriptions, key };
  }

  async pushMachineIfChanged(): Promise<void> {
    const relay = this.#relay;
    if (!relay) return;
    if (this.#snapshot().key === this.#lastPushed) return;
    this.#pushChain = this.#pushChain.then(async () => {
      const { union, plugins, descriptions, key } = this.#snapshot();
      if (key === this.#lastPushed) return;
      const ok = await relay.getOrCreateMachine({
        ...this.#base,
        slashCommands: union,
        pluginSlashCommands: plugins,
        slashCommandDescriptions: descriptions,
      });
      if (ok) this.#lastPushed = key;
    });
    return this.#pushChain;
  }

  /** On relay attach (launch / recover / reconnect): scan this session's
   *  project, push its list, and fold the project into machine knowledge. */
  async onSessionAttached(cwd: string, rs: RelaySession): Promise<void> {
    const scanned = scanProject(cwd);
    this.setProject(cwd, scanned.map((c) => c.name));
    this.#mergeDescriptions(scanned);
    try { await rs.updateSlashCommands(this.forProject(cwd)); } catch { /* best-effort */ }
    await this.pushMachineIfChanged();
  }

  /** Machine-page refresh: rescan machine + re-validate every known project
   *  (a project whose commands were removed drops out), then push + return. */
  refresh(): { slashCommands: string[] } {
    this.rescanMachine();
    for (const cwd of [...this.#projects.keys()]) {
      const scanned = scanProject(cwd);
      this.setProject(cwd, scanned.map((c) => c.name));
      this.#mergeDescriptions(scanned);
    }
    void this.pushMachineIfChanged();
    return { slashCommands: this.union() };
  }
}
