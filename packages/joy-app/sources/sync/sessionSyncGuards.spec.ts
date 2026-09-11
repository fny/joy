import { describe, it, expect } from 'vitest';
import { StaleFetchError, cursorsNeedReanchor, isSendAcknowledged } from './sessionSyncGuards';

// The fetch generation (#407) lives in sessionLogMachine.ts now; see its spec.
describe('isSendAcknowledged (#410)', () => {
    it('a row reconciled with a server seq counts as accepted', () => {
        expect(isSendAcknowledged({ seq: 101, deliveryStage: 'relay' })).toBe(true);
    });

    it('a row whose stage moved past local counts as accepted even without a seq', () => {
        expect(isSendAcknowledged({ seq: null, deliveryStage: 'agent' })).toBe(true);
    });

    it('an unconfirmed optimistic row is not accepted', () => {
        expect(isSendAcknowledged({ seq: null, deliveryStage: 'local' })).toBe(false);
        expect(isSendAcknowledged(undefined)).toBe(false);
        expect(isSendAcknowledged(null)).toBe(false);
    });
});

describe('cursorsNeedReanchor (#12)', () => {
    it('an evicted store with a surviving cursor must re-anchor', () => {
        expect(cursorsNeedReanchor(false, true)).toBe(true);
    });

    it('a cold session (no store, no cursor) and a loaded session are fine', () => {
        expect(cursorsNeedReanchor(false, false)).toBe(false);
        expect(cursorsNeedReanchor(true, true)).toBe(false);
        expect(cursorsNeedReanchor(true, false)).toBe(false);
    });
});
