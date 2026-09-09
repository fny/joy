import { describe, expect, it } from 'vitest';
import { buildSpawnSpec, type SpawnChoices } from './spawnSpec';
import { FALLBACK_HARNESS_CAPABILITIES, type HarnessCapabilities } from '@/sync/harnessCapabilities';

const everything: SpawnChoices = {
    cwd: '/p',
    gitUrl: 'https://x/y.git',
    agent: 'claude',
    model: 'opus',
    effort: 'high',
    permissionMode: 'plan',
    resumeId: 'abc',
    continueLast: true,
    fork: true,
    resumeMb: '3',
    fallbackModel: 'sonnet',
    extraArgs: '--allowedTools "Bash(git:*)"',
};

const nothing: HarnessCapabilities = {
    harness: 'pi',
    models: { pick: false, source: 'none', switchLive: false },
    effort: null,
    permissions: null,
    resume: { continueLast: false, byId: false, pastList: false, fork: false },
    extraArgs: null,
    fallbackModel: false,
    resumeLimitMb: false,
};

describe('buildSpawnSpec', () => {
    it('a harness that takes everything gets everything', () => {
        const spec = buildSpawnSpec(FALLBACK_HARNESS_CAPABILITIES.claude, everything);
        expect(spec).toEqual({
            cwd: '/p', gitUrl: 'https://x/y.git', agent: 'claude', model: 'opus', effort: 'high',
            resume_id: 'abc', continue: undefined, resumeLimitMb: 3, permissionMode: 'plan',
            fallbackModel: 'sonnet', forkSession: true, extraArgs: '--allowedTools "Bash(git:*)"',
        });
    });

    it('a harness that takes nothing gets only cwd and agent', () => {
        const spec = buildSpawnSpec(nothing, { ...everything, agent: 'pi' });
        const sent = Object.entries(spec).filter(([, v]) => v !== undefined).map(([k]) => k).sort();
        expect(sent).toEqual(['agent', 'cwd', 'gitUrl']);
    });

    it('resume by id wins over continue; fork needs one of them', () => {
        const caps = FALLBACK_HARNESS_CAPABILITIES.claude;
        expect(buildSpawnSpec(caps, { ...everything, resumeId: '' })).toMatchObject({ resume_id: undefined, continue: true, forkSession: true });
        expect(buildSpawnSpec(caps, { ...everything, resumeId: '', continueLast: false })).toMatchObject({ continue: undefined, forkSession: undefined, resumeLimitMb: undefined });
    });

    it("'default' effort and blank text send nothing", () => {
        const spec = buildSpawnSpec(FALLBACK_HARNESS_CAPABILITIES.claude, { ...everything, effort: 'default', extraArgs: '   ', resumeMb: 'x', fallbackModel: null });
        expect(spec.effort).toBeUndefined();
        expect(spec.extraArgs).toBeUndefined();
        expect(spec.fallbackModel).toBeUndefined();
        expect(spec.resumeLimitMb).toBe(1);
    });

    it('the old-daemon codex table: config overrides, no fork, no fallback, no backfill', () => {
        const spec = buildSpawnSpec(FALLBACK_HARNESS_CAPABILITIES.codex, { ...everything, agent: 'codex', model: 'gpt-5.6-sol', permissionMode: 'yolo', extraArgs: 'a=b' });
        expect(spec).toMatchObject({ model: 'gpt-5.6-sol', effort: 'high', permissionMode: 'yolo', resume_id: 'abc', extraArgs: 'a=b' });
        expect(spec.forkSession).toBeUndefined();
        expect(spec.fallbackModel).toBeUndefined();
        expect(spec.resumeLimitMb).toBeUndefined();
    });
});
