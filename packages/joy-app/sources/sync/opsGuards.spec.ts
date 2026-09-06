import { describe, it, expect } from 'vitest';
import { approvalResponseError, resolveMetadataConflict } from './opsGuards';
import type { MachineMetadata } from './storageTypes';

describe('approvalResponseError (#381)', () => {
    it('accepts only an explicit 2xx { ok: true }', () => {
        expect(approvalResponseError(200, { ok: true })).toBeNull();
    });

    it('rejects a daemon 500 with an empty or non-JSON body', () => {
        // tunnelJson yields data:null for an empty/unparseable body — the old
        // code resolved this as a successful decision.
        expect(approvalResponseError(500, null)).toMatch(/HTTP 500/);
    });

    it('rejects an explicit ok:false without an error string', () => {
        expect(approvalResponseError(200, { ok: false })).toMatch(/not acknowledged/);
    });

    it('rejects a 2xx body with no ok field', () => {
        expect(approvalResponseError(200, {})).toMatch(/not acknowledged/);
        expect(approvalResponseError(200, null)).toMatch(/not acknowledged/);
    });

    it('surfaces the daemon error text when present', () => {
        expect(approvalResponseError(400, { error: 'approvals_unsupported' })).toBe('approvals_unsupported');
        expect(approvalResponseError(409, { error: 'request_not_pending' })).toBe('request_not_pending');
    });
});

const v1 = { host: 'old-host', displayName: 'old' } as unknown as MachineMetadata;
const v2 = { host: 'new-host', displayName: 'other', daemon: 'x' } as unknown as MachineMetadata;

describe('resolveMetadataConflict (#382)', () => {
    it('merges the requested displayName onto the OPENED current record', () => {
        const out = resolveMetadataConflict({ serverHasMetadata: true, opened: v2, ours: v1, displayName: 'mine' });
        expect(out).toEqual({ write: { ...v2, displayName: 'mine' } });
    });

    it('refuses to write when the current record exists but did not open', () => {
        // Advancing to the new version with our stale fields would CAS over
        // the concurrent host/daemon updates.
        const out = resolveMetadataConflict({ serverHasMetadata: true, opened: null, ours: v1, displayName: 'mine' });
        expect(out).toEqual({ retry: true });
    });

    it('overwrites an EMPTY server record with our copy (nothing to lose)', () => {
        const out = resolveMetadataConflict({ serverHasMetadata: false, opened: null, ours: v1, displayName: 'mine' });
        expect(out).toEqual({ write: { ...v1, displayName: 'mine' } });
    });
});
