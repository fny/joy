// What each harness can be asked for — ONE table, read by the app (via
// GET /v2/harnesses and joy-harness-capabilities) so the new-session screen
// and the session settings render from the same facts the daemon validates
// against (registry.create). Before this the app hard-coded who supports what
// in four places and the daemon in a fifth; a harness gaining a feature lit
// up nowhere until every copy was found.
//
// Keys are the wire values the create op takes (`model`, `effort`,
// `permissionMode`, `resume_id`, `continue`, `forkSession`, `extraArgs`,
// `fallbackModel`, `resume_limit_mb`). Names/descriptions are UI copy.

export const HARNESSES = ["claude", "codex", "opencode", "pi", "agy"] as const;
export type Harness = (typeof HARNESSES)[number];

export function isHarness(x: unknown): x is Harness {
  return typeof x === "string" && (HARNESSES as readonly string[]).includes(x);
}

export interface HarnessPermissionMode {
  key: string;
  name: string;
  description: string;
}

export interface HarnessCapabilities {
  harness: Harness;
  models: {
    /** The app shows a model picker. */
    pick: boolean;
    /** Where the catalog comes from: a fixed list in the app (claude), the
     *  machine (codex/opencode/pi/agy: GET /v2/harnesses/:h/models), or none. */
    source: "static" | "live" | "none";
    /** The model can be changed on a running session (joy-set-model). */
    switchLive: boolean;
  };
  /** null = the harness has no effort/thinking knob. */
  effort: {
    /** Fixed levels; empty when `perModel` (read them off the catalog entry). */
    levels: string[];
    default: string | null;
    perModel: boolean;
    switchLive: boolean;
  } | null;
  /** null = no permission surface at all. */
  permissions: {
    modes: HarnessPermissionMode[];
    default: string;
    switchLive: boolean;
  } | null;
  resume: {
    continueLast: boolean;
    byId: boolean;
    /** GET /v2/harnesses/:h/sessions?directory= lists resumable conversations. */
    pastList: boolean;
    /** `forkSession` with `resume_id` on create. */
    fork: boolean;
  };
  /** "cli": raw arguments appended to the launch line; "config": codex
   *  `key=value` config overrides; null: nothing to append to (a server). */
  extraArgs: "cli" | "config" | null;
  fallbackModel: boolean;
  resumeLimitMb: boolean;
}

const CLAUDE_MODES: HarnessPermissionMode[] = [
  { key: "bypassPermissions", name: "yolo", description: "Every tool call runs without asking (--dangerously-skip-permissions)." },
  { key: "auto", name: "auto", description: "Claude decides which tool calls need approval." },
  { key: "default", name: "default", description: "Ask before tool calls, as the CLI would." },
  { key: "acceptEdits", name: "accept edits", description: "File edits run without asking; other tools still ask." },
  { key: "plan", name: "plan", description: "Read-only planning: no edits, no commands." },
];

const CODEX_MODES: HarnessPermissionMode[] = [
  { key: "default", name: "default", description: "Approvals on request, writes confined to the workspace." },
  { key: "read-only", name: "read-only", description: "Read-only sandbox; nothing is written." },
  { key: "safe-yolo", name: "safe yolo", description: "No approvals, writes confined to the workspace." },
  { key: "yolo", name: "yolo", description: "No approvals, full disk access." },
];

const OPENCODE_MODES: HarnessPermissionMode[] = [
  { key: "default", name: "configured", description: "Whatever the agent's own permission config says (build agent)." },
  { key: "plan", name: "read-only", description: "The plan agent: reads and searches, no edits or commands." },
  { key: "yolo", name: "allow all", description: "Every permission set to allow on this session's server." },
];

const PI_MODES: HarnessPermissionMode[] = [
  { key: "default", name: "all tools", description: "read, bash, edit, write, grep, find, ls — pi never asks." },
  { key: "plan", name: "read-only tools", description: "Only read, grep, find and ls are enabled (--tools)." },
];

const AGY_MODES: HarnessPermissionMode[] = [
  { key: "bypassPermissions", name: "yolo", description: "Every tool call runs without asking (headless print mode cannot answer a prompt)." },
  { key: "acceptEdits", name: "accept edits", description: "--mode accept-edits; approvals still skipped." },
  { key: "plan", name: "plan", description: "--mode plan: planning without edits; approvals still skipped." },
];

export const HARNESS_CAPABILITIES: Record<Harness, HarnessCapabilities> = {
  claude: {
    harness: "claude",
    models: { pick: true, source: "static", switchLive: true },
    effort: { levels: ["low", "medium", "high", "xhigh", "max"], default: null, perModel: false, switchLive: true },
    permissions: { modes: CLAUDE_MODES, default: "bypassPermissions", switchLive: true },
    resume: { continueLast: true, byId: true, pastList: true, fork: true },
    extraArgs: "cli",
    fallbackModel: true,
    resumeLimitMb: true,
  },
  codex: {
    harness: "codex",
    models: { pick: true, source: "live", switchLive: true },
    effort: { levels: ["low", "medium", "high", "xhigh"], default: "medium", perModel: true, switchLive: true },
    permissions: { modes: CODEX_MODES, default: "default", switchLive: true },
    resume: { continueLast: true, byId: true, pastList: true, fork: true },
    extraArgs: "config",
    fallbackModel: false,
    resumeLimitMb: false,
  },
  opencode: {
    harness: "opencode",
    models: { pick: true, source: "live", switchLive: true },
    // A model's reasoning variants (its `variants` keys in the catalog) are
    // its effort levels; the table itself lists none.
    effort: { levels: [], default: null, perModel: true, switchLive: true },
    permissions: { modes: OPENCODE_MODES, default: "default", switchLive: true },
    resume: { continueLast: true, byId: true, pastList: true, fork: false },
    extraArgs: null,
    fallbackModel: false,
    resumeLimitMb: false,
  },
  pi: {
    harness: "pi",
    models: { pick: true, source: "live", switchLive: false },
    effort: { levels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"], default: null, perModel: false, switchLive: false },
    permissions: { modes: PI_MODES, default: "default", switchLive: false },
    resume: { continueLast: true, byId: true, pastList: true, fork: true },
    extraArgs: "cli",
    fallbackModel: false,
    resumeLimitMb: false,
  },
  agy: {
    harness: "agy",
    models: { pick: true, source: "live", switchLive: false },
    effort: { levels: ["low", "medium", "high"], default: null, perModel: false, switchLive: false },
    permissions: { modes: AGY_MODES, default: "bypassPermissions", switchLive: false },
    resume: { continueLast: true, byId: true, pastList: true, fork: true },
    extraArgs: "cli",
    fallbackModel: false,
    resumeLimitMb: false,
  },
};

/**
 * Older callers speak claude's vocabulary to every harness: the CLI sends
 * `bypassPermissions` for "not read-only", and executionPolicy.ts already
 * read that as codex's `yolo`. Map those aliases to the harness's own key
 * BEFORE validating, so a caller that predates the table keeps working;
 * anything else passes through for the table to judge.
 */
export function normalizePermissionMode(h: Harness, mode: string | undefined): string | undefined {
  if (mode === undefined) return undefined;
  const own = permissionModesFor(h);
  if (!own || own.has(mode)) return mode;
  if (mode === "bypassPermissions" || mode === "yolo") {
    if (h === "codex" || h === "opencode") return "yolo";
    if (h === "pi") return "default";
    if (h === "agy") return "bypassPermissions";
  }
  if (mode === "default" && h === "agy") return "bypassPermissions";
  if (mode === "acceptEdits" && h === "codex") return "default";
  return mode;
}

/** The permission-mode keys a harness accepts on create, or null when it has
 *  no permission surface. */
export function permissionModesFor(h: Harness): Set<string> | null {
  const p = HARNESS_CAPABILITIES[h].permissions;
  return p ? new Set(p.modes.map((m) => m.key)) : null;
}

/** Fixed effort levels a harness accepts on create; null when the knob does
 *  not exist; an empty set when the levels are per model (validate against
 *  the catalog instead). */
export function effortLevelsFor(h: Harness): Set<string> | null {
  const e = HARNESS_CAPABILITIES[h].effort;
  return e ? new Set(e.levels) : null;
}
