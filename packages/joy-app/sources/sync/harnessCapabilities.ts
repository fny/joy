/**
 * What each harness can do, as the daemon reports it — the ONE table the
 * new-session page, the session settings sheet and the composer's status
 * row render from.
 *
 * Until now the app kept this knowledge in four places (the new-session
 * screen's `selectedAgent === 'codex' ? … : …` chains, the session view's
 * gates, agentDefaultOptions, modelModeOptions), each a hand-maintained copy
 * of what the daemon accepts. A harness gaining a feature on the daemon had
 * to be re-taught to every copy, and the copies disagreed: pi has taken
 * `--model` for months while the page offered no picker; codex could fork
 * but only the session actions knew.
 *
 * The daemon now publishes the table on GET /v2/harnesses. An older daemon
 * publishes descriptors without it, and for those the app falls back to
 * FALLBACK_HARNESS_CAPABILITIES — exactly what such a daemon accepts today,
 * so a stale machine keeps the rows it always had rather than gaining
 * controls it would silently ignore.
 */

export const HARNESS_IDS = ['claude', 'codex', 'opencode', 'pi', 'agy'] as const;
export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: unknown): value is HarnessId {
    return typeof value === 'string' && (HARNESS_IDS as readonly string[]).includes(value);
}

export interface HarnessPermissionMode {
    key: string;
    name: string;
    description: string;
}

export interface HarnessCapabilities {
    harness: HarnessId;
    models: {
        /** The page offers a model picker. */
        pick: boolean;
        /** Where the catalog comes from: the app's own list (claude), the
         *  daemon's live catalog, or nowhere (the CLI's own default only). */
        source: 'static' | 'live' | 'none';
        /** The model can be changed on a running session. */
        switchLive: boolean;
    };
    effort: {
        levels: string[];
        /** Seeded selection; null = "leave it to the harness". */
        default: string | null;
        /** Levels come from the picked catalog entry (`supportedReasoningEfforts`
         *  or `variants`) rather than `levels`. */
        perModel: boolean;
        switchLive: boolean;
    } | null;
    permissions: {
        modes: HarnessPermissionMode[];
        default: string;
        switchLive: boolean;
    } | null;
    resume: {
        continueLast: boolean;
        byId: boolean;
        pastList: boolean;
        fork: boolean;
    };
    /** Free-form extra input: verbatim CLI args, key=value config overrides, or none. */
    extraArgs: 'cli' | 'config' | null;
    fallbackModel: boolean;
    resumeLimitMb: boolean;
}

const CLAUDE_MODES: HarnessPermissionMode[] = [
    { key: 'bypassPermissions', name: 'yolo', description: 'permission prompts are skipped' },
    { key: 'auto', name: 'auto', description: 'auto-approve safe actions' },
    { key: 'default', name: 'default', description: 'ask before risky actions' },
    { key: 'acceptEdits', name: 'accept edits', description: 'edits without asking' },
    { key: 'plan', name: 'plan', description: 'read-only planning' },
];
const CODEX_MODES: HarnessPermissionMode[] = [
    { key: 'default', name: 'default', description: 'on-request approvals, workspace-write' },
    { key: 'read-only', name: 'read only', description: 'on-request approvals, read-only sandbox' },
    { key: 'safe-yolo', name: 'safe yolo', description: 'no prompts, workspace-confined' },
    { key: 'yolo', name: 'yolo', description: 'no prompts, full access' },
];

/**
 * What a daemon WITHOUT the capability table accepts (today's release).
 * Deliberately conservative: only rows whose values that daemon honours.
 */
export const FALLBACK_HARNESS_CAPABILITIES: Record<HarnessId, HarnessCapabilities> = {
    claude: {
        harness: 'claude',
        models: { pick: true, source: 'static', switchLive: true },
        effort: { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: null, perModel: false, switchLive: true },
        permissions: { modes: CLAUDE_MODES, default: 'bypassPermissions', switchLive: true },
        resume: { continueLast: true, byId: true, pastList: true, fork: true },
        extraArgs: 'cli',
        fallbackModel: true,
        resumeLimitMb: true,
    },
    codex: {
        harness: 'codex',
        models: { pick: true, source: 'live', switchLive: false },
        effort: { levels: ['low', 'medium', 'high', 'xhigh'], default: 'medium', perModel: true, switchLive: false },
        permissions: { modes: CODEX_MODES, default: 'yolo', switchLive: true },
        resume: { continueLast: true, byId: true, pastList: false, fork: false },
        extraArgs: 'config',
        fallbackModel: false,
        resumeLimitMb: false,
    },
    opencode: {
        harness: 'opencode',
        models: { pick: true, source: 'live', switchLive: true },
        effort: null,
        permissions: null,
        resume: { continueLast: true, byId: true, pastList: true, fork: false },
        extraArgs: null,
        fallbackModel: false,
        resumeLimitMb: false,
    },
    pi: {
        harness: 'pi',
        models: { pick: false, source: 'none', switchLive: false },
        effort: null,
        permissions: null,
        resume: { continueLast: true, byId: true, pastList: false, fork: false },
        extraArgs: null,
        fallbackModel: false,
        resumeLimitMb: false,
    },
    agy: {
        harness: 'agy',
        models: { pick: true, source: 'live', switchLive: false },
        effort: null,
        permissions: null,
        resume: { continueLast: true, byId: true, pastList: false, fork: false },
        extraArgs: null,
        fallbackModel: false,
        resumeLimitMb: false,
    },
};

/** One row of GET /v2/harnesses. `capabilities` is absent on an older daemon. */
export interface HarnessDescriptor {
    id?: unknown;
    available?: unknown;
    config?: unknown;
    capabilities?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/**
 * The capabilities a descriptor carries, normalised field by field against
 * the fallback for that harness: a daemon that publishes the table but not
 * yet every field (or a future field this app does not know) still resolves
 * to a complete object. A descriptor without a table is the fallback.
 */
export function resolveHarnessCapabilities(descriptor: HarnessDescriptor | undefined, harness: HarnessId): HarnessCapabilities {
    const base = FALLBACK_HARNESS_CAPABILITIES[harness];
    const c = descriptor?.capabilities;
    if (!isRecord(c) || !isRecord(c.models)) return base;
    const models = c.models;
    const source = models.source === 'static' || models.source === 'live' || models.source === 'none' ? models.source : base.models.source;
    let effort: HarnessCapabilities['effort'] = null;
    if (isRecord(c.effort)) {
        const levels = strings(c.effort.levels);
        effort = {
            levels,
            default: typeof c.effort.default === 'string' ? c.effort.default : null,
            perModel: bool(c.effort.perModel, false),
            switchLive: bool(c.effort.switchLive, false),
        };
    }
    let permissions: HarnessCapabilities['permissions'] = null;
    const perm = c.permissions;
    if (isRecord(perm) && Array.isArray(perm.modes)) {
        const modes = perm.modes
            .filter(isRecord)
            .filter((m) => typeof m.key === 'string' && m.key)
            .map((m) => ({
                key: m.key as string,
                name: typeof m.name === 'string' && m.name ? m.name : (m.key as string),
                description: typeof m.description === 'string' ? m.description : '',
            }));
        if (modes.length > 0) {
            const wanted = typeof perm.default === 'string' ? perm.default : null;
            const def = wanted !== null && modes.some((m) => m.key === wanted) ? wanted : modes[0].key;
            permissions = { modes, default: def, switchLive: bool(perm.switchLive, false) };
        }
    }
    const resume = isRecord(c.resume) ? c.resume : {};
    const extraArgs = c.extraArgs === 'cli' || c.extraArgs === 'config' ? c.extraArgs : null;
    return {
        harness,
        models: {
            pick: bool(models.pick, base.models.pick),
            source,
            switchLive: bool(models.switchLive, base.models.switchLive),
        },
        effort,
        permissions,
        resume: {
            continueLast: bool(resume.continueLast, base.resume.continueLast),
            byId: bool(resume.byId, base.resume.byId),
            pastList: bool(resume.pastList, false),
            fork: bool(resume.fork, false),
        },
        extraArgs,
        fallbackModel: bool(c.fallbackModel, false),
        resumeLimitMb: bool(c.resumeLimitMb, false),
    };
}

/** The whole table from a GET /v2/harnesses body (or an older daemon's). */
export function resolveHarnessTable(descriptors: unknown): Record<HarnessId, HarnessCapabilities> {
    const list = Array.isArray(descriptors) ? descriptors.filter(isRecord) : [];
    const out = {} as Record<HarnessId, HarnessCapabilities>;
    for (const h of HARNESS_IDS) {
        out[h] = resolveHarnessCapabilities(list.find((d) => d.id === h) as HarnessDescriptor | undefined, h);
    }
    return out;
}
