/**
 * Pure decision helpers for ops.ts, kept free of the storage/sync singletons
 * so they can be unit-tested.
 */
import type { MachineMetadata } from './storageTypes';

/**
 * Validate a daemon approval response. The daemon answers
 * `POST /v2/sessions/:id/approvals` with `{ ok: boolean }` on 200, or
 * `{ error }` with a 4xx. tunnelJson never throws on a daemon status — a 500
 * with an empty body comes back as `status:500, data:null`, and the old
 * `if (data?.error) throw` treated that (and an explicit `ok:false`) as a
 * successfully applied decision, so the approval stayed pending on the
 * machine while the app dismissed it (#381).
 *
 * Returns null when the decision was acknowledged, otherwise the error text.
 */
export function approvalResponseError(status: number, data: { ok?: unknown; error?: unknown } | null): string | null {
    if (data && typeof data.error === 'string' && data.error) return data.error;
    if (status < 200 || status >= 300) return `approval failed (HTTP ${status})`;
    if (!data || data.ok !== true) return 'approval not acknowledged by the daemon';
    return null;
}

/**
 * Decide what to submit after a metadata CAS conflict.
 *
 * On `version-mismatch` the relay returns the CURRENT sealed record. The
 * retry must merge our change onto THAT record; if the record exists but
 * could not be opened (transient decrypt failure, key mid-recovery), the old
 * code fell back to the caller's stale copy and resubmitted it against the
 * NEW version — a successful CAS that overwrote every concurrent update
 * (host, daemon fields) with version-1 data (#382). Now: no opened record →
 * no write (`retry: true`, the caller re-reads); an empty server record is
 * safe to overwrite with our copy.
 */
export function resolveMetadataConflict(args: {
    serverHasMetadata: boolean;
    opened: MachineMetadata | null;
    ours: MachineMetadata;
    displayName: MachineMetadata['displayName'];
}): { write: MachineMetadata } | { retry: true } {
    if (args.serverHasMetadata && !args.opened) return { retry: true };
    return { write: { ...(args.opened ?? args.ours), displayName: args.displayName } };
}
