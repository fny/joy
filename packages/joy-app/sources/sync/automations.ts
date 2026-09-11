// App-side authoring for automations.
//
// The app can do what the CLI cannot: seal for ANY machine. A spec is sealed
// under the target machine's spawn-spec key, and the app holds the account
// key, so it can decrypt every machine's data key (sync.machineDataKeys) and
// derive every machine's spawn-spec leaf. `joy automation create` on boite can
// only ever author for boite; this can author for all of them.
//
// The payload is a SpawnSpec — an automation run is an ordinary headless
// session — so this is the same envelope the new-session screen already
// builds, plus a prompt and the headless flag.
import { sync } from '@/sync/sync';
import { v2, type V2Automation } from '@/sync/v2/api';
import { deriveSpawnSpecKey, encodeSpawnSpec, openSpawnSpec } from '@/sync/v2/spawnSpec';

export interface AutomationDraft {
    machineId: string;
    directory: string;
    name: string;
    prompt: string;
    agent?: string;
    model?: string;
    trigger: string;
    /** For `schedule` this IS the cron expression — a trigger is an event
     *  source plus a filter, and for a schedule the filter is the expression. */
    triggerFilter?: string;
    timezone?: string;
}

/** What an automation actually runs, once opened. */
export interface AutomationSpec {
    cwd?: string;
    agent?: string;
    model?: string;
    prompt?: string;
    headless?: boolean;
    yolo?: boolean;
}

/** The machine's spawn-spec key, or null when this device cannot derive it —
 *  a machine whose data key has not been decrypted yet (still syncing), or one
 *  that publishes none. Null means the spec travels as plain JSON, which every
 *  daemon still accepts; it must never mean "silently fail to create". */
async function specKeyFor(machineId: string): Promise<Uint8Array | null> {
    const ctx = sync.machineCtxFor(machineId, '');
    if (!ctx?.machineKey) return null;
    return deriveSpawnSpecKey(ctx.machineKey, machineId);
}

/** The sealed spec for a draft — shared by create and edit, so an edited
 *  automation is sealed exactly the way a new one is. */
async function sealFor(draft: AutomationDraft): Promise<string> {
    const key = await specKeyFor(draft.machineId);
    return encodeSpawnSpec({
        t: 'spawn',
        cwd: draft.directory,
        agent: draft.agent || 'claude',
        ...(draft.model ? { model: draft.model } : {}),
        prompt: draft.prompt,
        // Both follow from what a run IS: nobody is watching it, and a run
        // that stops for a human is a failure rather than something to wait
        // on. Neither is a choice the author should have to make.
        headless: true,
        yolo: true,
    } as Parameters<typeof encodeSpawnSpec>[0], key);
}

function triggersOf(draft: AutomationDraft) {
    return [{
        kind: draft.trigger,
        ...(draft.triggerFilter ? { filter: draft.triggerFilter } : {}),
        ...(draft.timezone ? { timezone: draft.timezone } : {}),
    }];
}

export async function createAutomation(draft: AutomationDraft): Promise<V2Automation> {
    const { automation } = await v2.createAutomation({
        name: draft.name.trim() || draft.prompt.trim().split(/\s+/).slice(0, 6).join(' '),
        machineId: draft.machineId,
        directory: draft.directory,
        spec: await sealFor(draft),
        triggers: triggersOf(draft),
    });
    return automation;
}

/**
 * Save an edit.
 *
 * The spec write is CONDITIONAL on the version that was loaded: two devices
 * editing one automation is the same race the machine record already answers
 * this way, and losing somebody else's edit silently is worse than being told
 * to look again. The machine can change here too, which re-seals under the
 * NEW machine's key — an automation can be moved between machines from the
 * app, which the CLI can never do.
 */
export async function updateAutomation(
    id: string,
    draft: AutomationDraft,
    expectedSpecVersion: number,
): Promise<V2Automation> {
    const { automation } = await v2.patchAutomation(id, {
        name: draft.name.trim(),
        machineId: draft.machineId,
        directory: draft.directory,
        spec: await sealFor(draft),
        expectedSpecVersion,
        triggers: triggersOf(draft),
    });
    return automation;
}

/** Open an automation's spec for display. Returns null when this device
 *  cannot derive that machine's key — the page then shows what the relay
 *  knows (folder, triggers, outcomes) and says the prompt is unreadable here,
 *  rather than rendering a sealed blob as if it were text. */
export async function openAutomationSpec(a: V2Automation): Promise<AutomationSpec | null> {
    const key = await specKeyFor(a.machineId);
    try {
        return openSpawnSpec(a.spec, key) as AutomationSpec | null;
    } catch {
        return null;
    }
}
