import { describe, expect, it } from 'vitest';
import { MetadataSchema } from './storageTypes';

describe('MetadataSchema', () => {
    it('preserves archive lifecycle metadata', () => {
        const metadata = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'local-machine',
            startedBy: 'daemon',
            startedFromDaemon: true,
            lifecycleState: 'archived',
            lifecycleStateSince: 123,
            archivedBy: 'cli',
            archiveReason: 'User terminated',
        });

        expect(metadata.startedBy).toBe('daemon');
        expect(metadata.startedFromDaemon).toBe(true);
        expect(metadata.lifecycleState).toBe('archived');
        expect(metadata.lifecycleStateSince).toBe(123);
        expect(metadata.archivedBy).toBe('cli');
        expect(metadata.archiveReason).toBe('User terminated');
    });

    // #130: the daemon's joy__eventBudget {since, dropped} used to be stripped
    // on decode (zod strips unknown keys), so the app could never render the
    // one warning that a session's output was dropped for good.
    it('keeps joy__eventBudget so the dropped-output warning survives decoding', () => {
        const metadata = MetadataSchema.parse({ path: '/repo', host: 'machine', joy__eventBudget: { since: 1, dropped: 5 } });
        expect(metadata.joy__eventBudget).toEqual({ since: 1, dropped: 5 });
        expect(MetadataSchema.parse({ path: '/repo', host: 'machine', joy__eventBudget: null }).joy__eventBudget).toBeNull();
        expect(MetadataSchema.parse({ path: '/repo', host: 'machine' }).joy__eventBudget).toBeUndefined();
    });
});
