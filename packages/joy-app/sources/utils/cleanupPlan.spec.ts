import { describe, it, expect } from 'vitest';
import { planFolderDeletion, recheckDetached, describeFolderDeletion, tallyDeletions, FOLDER_DELETE_IF_STATUS } from './cleanupPlan';

describe('cleanupPlan — folder deletion (#173)', () => {
    it('separates records whose agent is gone from sessions that must be stopped first', () => {
        const plan = planFolderDeletion([
            { id: 'a', state: 'running' },
            { id: 'b', state: 'detached' },
            { id: 'c', state: 'archived' },
            { id: 'd', state: 'running' },
        ]);
        expect(plan.deleteNow).toEqual(['b', 'c']);
        expect(plan.stopFirst).toEqual(['a', 'd']);
    });
    it('an unknown lifecycle counts as live — the record is never deleted under a possibly-working agent', () => {
        const plan = planFolderDeletion([{ id: 'x', state: undefined }, { id: 'y', state: null }, { id: 'z', state: 'weird' }]);
        expect(plan.deleteNow).toEqual([]);
        expect(plan.stopFirst).toEqual(['x', 'y', 'z']);
    });
    it('the confirmation says running sessions will be stopped when any are', () => {
        expect(describeFolderDeletion({ deleteNow: ['b'], stopFirst: [] }, 'joy')).toMatch(/^Permanently deletes 1 session record for "joy"/);
        const msg = describeFolderDeletion({ deleteNow: ['b'], stopFirst: ['a', 'd'] }, 'joy');
        expect(msg).toMatch(/^Stops 2 running sessions first/);
        expect(msg).toContain('3 session records');
        expect(msg).toContain('keep their records');
    });
});

describe('cleanupPlan — detached re-check (#174)', () => {
    it('a session that restarted between listing and confirming is skipped, not killed', () => {
        const fresh: Record<string, string> = { s1: 'detached', s2: 'running', s3: 'detached' };
        const r = recheckDetached(['s1', 's2', 's3'], (id) => fresh[id]);
        expect(r.kill).toEqual(['s1', 's3']);
        expect(r.skip).toEqual(['s2']);
    });
    it('a session that vanished or was archived is skipped too', () => {
        const fresh: Record<string, string | undefined> = { s1: undefined, s2: 'archived' };
        const r = recheckDetached(['s1', 's2'], (id) => fresh[id]);
        expect(r.kill).toEqual([]);
        expect(r.skip).toEqual(['s1', 's2']);
    });
});

describe('cleanupPlan — conditional record deletion (#173)', () => {
    it('names only the states with no live agent behind them', () => {
        const states = FOLDER_DELETE_IF_STATUS.split(',');
        expect(states).toEqual(['detached', 'archived', 'failed']);
        for (const live of ['provisioning', 'starting', 'active']) expect(states).not.toContain(live);
    });

    it('tells a relay refusal (the session was live at the delete) apart from a plain failure', () => {
        const t = tallyDeletions([
            { id: 'gone', success: true },
            { id: 'live', success: false, code: 'status_mismatch' },
            { id: 'net', success: false },
            { id: 'gone2', success: true },
        ]);
        expect(t.deleted).toEqual(['gone', 'gone2']);
        expect(t.live).toEqual(['live']);
        expect(t.failed).toEqual(['net']);
    });
});
