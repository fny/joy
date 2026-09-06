/**
 * Which machine the new-session screen should pre-select, as a pure decision
 * over the CURRENT inputs — the machine list, the last-used machine, and the
 * joy-machines discovery entry for the current online set.
 *
 * The screen used to run the discovery probe itself, behind a permanent
 * "probed once" latch set before the probe was awaited. When the machine set
 * changed mid-probe the effect cleanup cancelled the consumer, the next run
 * hit the latch and returned, and the screen never selected anything nor
 * probed the new set (E4 sweep residual, Astra waveE4 picker). The probe is
 * now a resource keyed by the online set (sync/machineResources
 * joyMachinesSpec, the #178 shape of the settings screen): a change of the
 * set is a new key, so a run for the old set settles into the old key and
 * can neither select for, nor block, the new one. This helper only reads
 * the entry the screen is subscribed to right now.
 */

export interface RecentMachinePath {
    machineId: string;
    path?: string;
}

export interface DiscoveryView {
    /** The ids that answered the probe for the CURRENT online set, or
     *  undefined until that probe has answered once. */
    data: readonly string[] | undefined;
    /** The newest probe for this set ended without data (error/unavailable)
     *  and none is running: fall back rather than wait forever. */
    failed: boolean;
}

export interface AutoSelectInput<M extends { id: string }> {
    selectedMachineId: string | null;
    allMachines: readonly M[];
    isOnline: (m: M) => boolean;
    /** The most recently used machine + folder, if any. */
    recent: RecentMachinePath | undefined;
    /** A folder arrived with the screen (deep link): never overwrite it. */
    keepPath: boolean;
    discovery: DiscoveryView;
}

export type AutoSelectDecision =
    | { kind: 'keep' }
    | { kind: 'probing' }
    | { kind: 'select'; machineId: string; path?: string };

/** Ids of the online machines, in list order — what the discovery spec is keyed by. */
export function onlineMachineIds<M extends { id: string }>(allMachines: readonly M[], isOnline: (m: M) => boolean): string[] {
    return allMachines.filter(isOnline).map(m => m.id);
}

export function planMachineAutoSelect<M extends { id: string }>(input: AutoSelectInput<M>): AutoSelectDecision {
    const { selectedMachineId, allMachines, isOnline, recent, keepPath, discovery } = input;
    if (selectedMachineId) return { kind: 'keep' };
    // Prefer the last-used machine when it's online; pre-fill its folder too
    // (unless a path was passed in via params).
    const recentMachine = recent ? allMachines.find(m => m.id === recent.machineId) : undefined;
    if (recentMachine && isOnline(recentMachine)) {
        return { kind: 'select', machineId: recentMachine.id, ...(!keepPath && recent?.path ? { path: recent.path } : {}) };
    }
    const online = allMachines.filter(isOnline);
    if (online.length === 0) {
        return allMachines.length > 0 ? { kind: 'select', machineId: allMachines[0].id } : { kind: 'keep' };
    }
    // Pick the first online machine that answered the joy-daemon probe.
    // Without this we'd auto-select the first online machine — which usually
    // doesn't run joy-tmux — and the create RPC would hang silently.
    if (discovery.data) {
        const found = online.find(m => discovery.data!.includes(m.id));
        return { kind: 'select', machineId: found?.id ?? online[0].id };
    }
    if (discovery.failed) return { kind: 'select', machineId: online[0].id };
    return { kind: 'probing' };
}
