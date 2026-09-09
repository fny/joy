/**
 * The spawn spec for a new session, from the page's choices and the
 * harness's capabilities. Pure, so it can be checked that nothing the
 * capability table does not allow is ever sent — the daemon validates per
 * harness and refuses, but a refused create is a worse experience than a
 * control that was never offered.
 */
import type { V2SpawnSpec } from '@/sync/v2/spawn';
import type { HarnessCapabilities } from '@/sync/harnessCapabilities';

export interface SpawnChoices {
    cwd: string;
    gitUrl?: string;
    agent: HarnessCapabilities['harness'];
    /** The picked model's key (what the daemon's create takes), or undefined for the harness default. */
    model?: string;
    /** The picked effort; 'default' or undefined sends nothing. */
    effort?: string;
    permissionMode?: string;
    resumeId: string;
    continueLast: boolean;
    fork: boolean;
    /** MB of history to backfill on resume; '' or NaN → 1. */
    resumeMb: string;
    fallbackModel?: string | null;
    extraArgs: string;
}

export type SpawnSpecWithClone = V2SpawnSpec & { gitUrl?: string };

export function buildSpawnSpec(caps: HarnessCapabilities, c: SpawnChoices): SpawnSpecWithClone {
    const resumeId = c.resumeId.trim() || undefined;
    const continueLast = caps.resume.continueLast && c.continueLast && !resumeId ? true : undefined;
    const resuming = !!resumeId || !!continueLast;
    const effort = c.effort && c.effort !== 'default' ? c.effort : undefined;
    const mb = Number(c.resumeMb);
    return {
        cwd: c.cwd,
        gitUrl: c.gitUrl,
        agent: c.agent,
        model: caps.models.pick ? c.model : undefined,
        effort: caps.effort ? effort : undefined,
        // resume by id wins over --continue (most recent); never both.
        resume_id: caps.resume.byId ? resumeId : undefined,
        continue: continueLast,
        resumeLimitMb: caps.resumeLimitMb && resuming ? (Number.isFinite(mb) && mb >= 0 ? mb : 1) : undefined,
        permissionMode: caps.permissions ? c.permissionMode : undefined,
        fallbackModel: caps.fallbackModel ? (c.fallbackModel ?? undefined) : undefined,
        forkSession: caps.resume.fork && resuming && c.fork ? true : undefined,
        extraArgs: caps.extraArgs ? (c.extraArgs.trim() || undefined) : undefined,
    };
}
