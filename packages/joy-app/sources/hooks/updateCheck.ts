/**
 * The OTA update check, separated from React so its decisions are testable.
 *
 * Three defects lived in useUpdates (#327 #328 #329):
 * - the in-progress guard was React state read by a listener installed once,
 *   so a foreground transition during the initial check started a second,
 *   overlapping check;
 * - a rollback-to-embedded directive (`isAvailable:false, isRollBackToEmbedded:
 *   true`) was ignored — the faulty OTA could never be rolled back from a
 *   foreground check;
 * - `fetchUpdateAsync` resolving with `isNew:false` (update withdrawn between
 *   check and fetch) still flipped the "update ready, reload" state.
 *
 * `createUpdateChecker` holds ONE synchronous guard for the whole
 * check+download; a caller that finds it busy gets `null` and starts nothing.
 */
import { createInFlightGuard } from '@/utils/inFlightGuard';

export type PendingOtaUpdate = {
    ota_version?: string;
    ota_runtime_version?: string;
};

type ManifestLike = { id?: string; runtimeVersion?: string } | undefined | null;

export interface UpdateCheckApi {
    checkForUpdateAsync(): Promise<{ isAvailable: boolean; isRollBackToEmbedded: boolean; manifest?: ManifestLike }>;
    fetchUpdateAsync(): Promise<{ isNew: boolean; isRollBackToEmbedded: boolean; manifest?: ManifestLike }>;
}

export type UpdateCheckOutcome =
    | { kind: 'none' }
    | { kind: 'ready'; rollback: boolean; pending: PendingOtaUpdate | null };

function pendingFrom(manifest: ManifestLike): PendingOtaUpdate | null {
    if (!manifest) return null;
    return {
        ota_version: manifest.id,
        ota_runtime_version: typeof manifest.runtimeVersion === 'string' ? manifest.runtimeVersion : undefined,
    };
}

/** One check: decide whether anything is downloadable, download it, and say
 *  whether a reload is now worthwhile. Rejections propagate to the caller. */
export async function performUpdateCheck(api: UpdateCheckApi): Promise<UpdateCheckOutcome> {
    const check = await api.checkForUpdateAsync();
    // A rollback directive is actionable even though no manifest is available (#328).
    if (!check.isAvailable && !check.isRollBackToEmbedded) return { kind: 'none' };
    const fetched = await api.fetchUpdateAsync();
    if (fetched.isRollBackToEmbedded) return { kind: 'ready', rollback: true, pending: null };
    // Nothing new was downloaded (withdrawn between check and fetch) — no
    // reload invitation (#329). Metadata comes from the FETCHED manifest.
    if (!fetched.isNew) return { kind: 'none' };
    return { kind: 'ready', rollback: false, pending: pendingFrom(fetched.manifest ?? check.manifest) };
}

export interface UpdateChecker {
    /** True while a check+download is running. */
    readonly busy: boolean;
    /** Run a check unless one is already running (then resolves null without
     *  touching the update API). */
    check(): Promise<UpdateCheckOutcome | null>;
}

export function createUpdateChecker(api: UpdateCheckApi): UpdateChecker {
    const guard = createInFlightGuard();
    return {
        get busy() { return guard.busy; },
        check: () => guard.run(() => performUpdateCheck(api)),
    };
}
