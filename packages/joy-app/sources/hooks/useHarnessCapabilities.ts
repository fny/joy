import { useResource } from '@/hooks/useResource';
import { harnessCapabilitiesSpec } from '@/sync/machineResources';
import { FALLBACK_HARNESS_CAPABILITIES, isHarnessId, type HarnessCapabilities, type HarnessId } from '@/sync/harnessCapabilities';

/**
 * What `harness` can do on `machineId`, as that machine's daemon reports it.
 * Until the table has loaded — and for a daemon that publishes none — the
 * fallback table (what an older daemon accepts) is returned, so a screen
 * never renders a control the machine would ignore.
 */
export function useHarnessCapabilities(machineId: string | null | undefined, harness: string | null | undefined): HarnessCapabilities {
    const h: HarnessId = isHarnessId(harness) ? harness : 'claude';
    const table = useResource(machineId ? harnessCapabilitiesSpec(machineId) : null);
    return table.data?.[h] ?? FALLBACK_HARNESS_CAPABILITIES[h];
}
