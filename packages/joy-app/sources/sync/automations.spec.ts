import { describe, expect, it, vi } from 'vitest';

/**
 * What the app can author that the CLI cannot.
 *
 * The whole asymmetry: a daemon holds ONE machine key, so `joy automation
 * create` on boite can only make an automation that runs on boite. The app
 * holds the account key and decrypts every machine's data key, so it can
 * derive every machine's spawn-spec leaf and author for all of them. These
 * tests pin that, and pin the two flags an author never chooses.
 */
vi.mock('@/sync/sync', () => ({
    sync: {
        machineCtxFor: (machineId: string) =>
            machineId === 'unknown-machine' ? null : { machineKey: new Uint8Array(32).fill(7) },
    },
}));

const created: any[] = [];
vi.mock('@/sync/v2/api', () => ({
    v2: {
        createAutomation: async (body: any) => { created.push(body); return { automation: { id: 'a1', ...body } }; },
    },
}));

const sealed: Array<{ spec: any; key: Uint8Array | null }> = [];
vi.mock('@/sync/v2/spawnSpec', () => ({
    deriveSpawnSpecKey: async (key: Uint8Array) => key,
    encodeSpawnSpec: (spec: any, key: Uint8Array | null) => { sealed.push({ spec, key }); return key ? 'sealed' : JSON.stringify(spec); },
    openSpawnSpec: (wire: string) => (wire === 'sealed' ? { prompt: 'opened' } : null),
}));

const { createAutomation } = await import('./automations');

const draft = (over = {}) => ({
    machineId: 'fny',
    directory: '/srv/work',
    name: '',
    prompt: 'run the tests',
    trigger: 'manual',
    ...over,
});

describe('createAutomation', () => {
    it('seals under the TARGET machine, not this device', async () => {
        sealed.length = 0;
        await createAutomation(draft({ machineId: 'boite' }));
        expect(sealed[0].key).toBeInstanceOf(Uint8Array);
    });

    it('always headless and always prompts-off — neither is the author\'s choice', async () => {
        sealed.length = 0;
        await createAutomation(draft());
        // Both follow from what a run IS: nobody watches it, and one that
        // stops for a human is a failure rather than something to wait on.
        expect(sealed[0].spec).toMatchObject({ headless: true, yolo: true });
    });

    it('carries the prompt into the spec, where the relay cannot read it', async () => {
        sealed.length = 0;
        await createAutomation(draft({ prompt: 'fix the flaky test' }));
        expect(sealed[0].spec.prompt).toBe('fix the flaky test');
    });

    it('names an unnamed automation from its prompt rather than leaving it blank', async () => {
        created.length = 0;
        await createAutomation(draft({ name: '', prompt: 'run every integration test and report what broke overnight' }));
        expect(created[0].name).toBe('run every integration test and report');
    });

    it('keeps a name the author gave', async () => {
        created.length = 0;
        await createAutomation(draft({ name: '  nightly  ' }));
        expect(created[0].name).toBe('nightly');
    });

    it('falls back to PLAIN json for a machine whose key is unknown, rather than failing to create', async () => {
        // A machine still syncing, or one that publishes no data key. Every
        // daemon still accepts a plain spec; refusing to author would be worse.
        sealed.length = 0;
        await createAutomation(draft({ machineId: 'unknown-machine' }));
        expect(sealed[0].key).toBeNull();
    });

    it('sends the trigger the author picked', async () => {
        created.length = 0;
        await createAutomation(draft({ trigger: 'machine_online' }));
        expect(created[0].triggers).toEqual([{ kind: 'machine_online' }]);
    });

    it('a schedule carries its expression as the FILTER, plus a zone', async () => {
        // A trigger is an event source plus a filter, and for a schedule the
        // filter IS the cron expression — no separate column, no new shape.
        created.length = 0;
        await createAutomation(draft({ trigger: 'schedule', triggerFilter: '0 2 * * *', timezone: 'America/New_York' }));
        expect(created[0].triggers).toEqual([
            { kind: 'schedule', filter: '0 2 * * *', timezone: 'America/New_York' },
        ]);
    });
});
