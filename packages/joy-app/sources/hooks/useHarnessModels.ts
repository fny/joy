/**
 * A harness's model catalog on a machine, read through the shared resource
 * (sync/machineResources.harnessModelsSpec) so every consumer — the new-
 * session picker, the chat's model chip, the hand-off sheet — shares ONE
 * cache entry per machine + harness and inherits the layer's cancellation,
 * latest-wins and freshness rules instead of fetching on its own.
 */
import * as React from 'react';
import { resources } from '@/sync/resource';
import { harnessModelsSpec, type HarnessModel } from '@/sync/machineResources';
import { useResource, type ResourceView } from './useResource';

/** Subscribe to the catalog for `machineId` + `harness`; either missing renders the idle entry. */
export function useHarnessModels(machineId: string | null | undefined, harness: string | null | undefined): ResourceView<HarnessModel[]> {
    const spec = React.useMemo(
        () => (machineId && harness ? harnessModelsSpec(machineId, harness) : null),
        [machineId, harness],
    );
    return useResource(spec);
}

/**
 * One-shot read for an imperative flow (the hand-off sheet): the same entry
 * the hooks observe, answered from cache while fresh. Never throws — a
 * daemon that cannot answer is an empty catalog, as it is for the chip.
 */
export async function loadHarnessModels(machineId: string, harness: string): Promise<HarnessModel[]> {
    const entry = await resources.ensure(harnessModelsSpec(machineId, harness));
    return entry.data ?? [];
}
