import * as React from 'react';
import { useAllMachines } from '@/sync/storage';
import { isMachineOnline } from '@/utils/machineUtils';
import { apiSocket } from '@/sync/apiSocket';
import type { Machine } from '@/sync/storageTypes';

// Machines that answer a joy-tmux `joy-status` probe — i.e. the boxes actually
// running the joy daemon, not every Happy machine. Probes online machines in
// parallel with a per-probe timeout (machineRPC has none, so a box without
// joy-tmux never resolves). Result is cached module-level so revisits render
// instantly while a background re-probe refreshes it. Mirrors the pattern in
// settings/joy-sessions.
let cachedJoyMachineIds: Set<string> | null = null;

export function useJoyMachines(): { machines: Machine[]; probing: boolean } {
    const all = useAllMachines({ includeOffline: true });
    const onlineIds = all.filter(isMachineOnline).map(m => m.id);
    const [ids, setIds] = React.useState<Set<string> | null>(cachedJoyMachineIds);

    // Re-probe whenever the online-machine set changes (effect dep below), so a
    // daemon that comes online after first render is discovered. The cached
    // result keeps rendering meanwhile, so re-probes are silent (no flicker).
    React.useEffect(() => {
        if (onlineIds.length === 0) return;
        let cancelled = false;
        (async () => {
            const probe = (id: string) => Promise.race([
                apiSocket.machineRPC(id, 'joy-status', {}).then(() => id),
                new Promise<never>((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 3000)),
            ]);
            const results = await Promise.allSettled(onlineIds.map(probe));
            if (cancelled) return;
            const found = new Set(
                results.filter(r => r.status === 'fulfilled').map(r => (r as PromiseFulfilledResult<string>).value),
            );
            cachedJoyMachineIds = found;
            setIds(found);
        })();
        return () => { cancelled = true; };
    }, [onlineIds.join(',')]);

    const machines = React.useMemo(
        () => (ids ? all.filter(m => ids.has(m.id)) : []),
        [all, ids],
    );
    return { machines, probing: ids === null };
}
