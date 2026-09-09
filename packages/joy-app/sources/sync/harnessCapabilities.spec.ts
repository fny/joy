import { describe, expect, it } from 'vitest';
import { FALLBACK_HARNESS_CAPABILITIES, HARNESS_IDS, resolveHarnessCapabilities, resolveHarnessTable } from './harnessCapabilities';

describe('resolveHarnessCapabilities', () => {
    it('no descriptor, or one without a table: the fallback for that harness', () => {
        for (const h of HARNESS_IDS) {
            expect(resolveHarnessCapabilities(undefined, h)).toBe(FALLBACK_HARNESS_CAPABILITIES[h]);
            expect(resolveHarnessCapabilities({ id: h, available: true }, h)).toBe(FALLBACK_HARNESS_CAPABILITIES[h]);
            expect(resolveHarnessCapabilities({ id: h, capabilities: 'yes' }, h)).toBe(FALLBACK_HARNESS_CAPABILITIES[h]);
        }
    });

    it("a published table is the daemon's word, field by field", () => {
        const c = resolveHarnessCapabilities({ id: 'agy', capabilities: {
            models: { pick: true, source: 'live', switchLive: false },
            effort: { levels: ['low', 'medium', 'high'], default: 'medium' },
            permissions: { modes: [{ key: 'bypassPermissions', name: 'yolo' }, { key: 'plan' }], default: 'bypassPermissions' },
            resume: { continueLast: true, byId: true, pastList: true, fork: true },
            extraArgs: 'cli',
        } }, 'agy');
        expect(c.models).toEqual({ pick: true, source: 'live', switchLive: false });
        expect(c.effort).toEqual({ levels: ['low', 'medium', 'high'], default: 'medium', perModel: false, switchLive: false });
        expect(c.permissions?.modes.map((m) => m.key)).toEqual(['bypassPermissions', 'plan']);
        expect(c.permissions?.modes[1]).toEqual({ key: 'plan', name: 'plan', description: '' });
        expect(c.resume).toEqual({ continueLast: true, byId: true, pastList: true, fork: true });
        expect(c.extraArgs).toBe('cli');
        expect(c.fallbackModel).toBe(false);
        expect(c.resumeLimitMb).toBe(false);
    });

    it('a table that omits effort or permissions means none; a default outside the modes is corrected', () => {
        const c = resolveHarnessCapabilities({ id: 'pi', capabilities: {
            models: { pick: true, source: 'live' },
            permissions: { modes: [{ key: 'default' }, { key: 'plan' }], default: 'yolo' },
        } }, 'pi');
        expect(c.effort).toBeNull();
        expect(c.permissions?.default).toBe('default');
        expect(c.models.switchLive).toBe(false);
    });

    it('junk in a field falls back per field, never the whole table', () => {
        const c = resolveHarnessCapabilities({ id: 'codex', capabilities: {
            models: { pick: 'yes', source: 'cloud', switchLive: 1 },
            resume: 'all',
            extraArgs: 'json',
        } }, 'codex');
        expect(c.models).toEqual(FALLBACK_HARNESS_CAPABILITIES.codex.models);
        expect(c.resume.continueLast).toBe(true);
        expect(c.resume.pastList).toBe(false);
        expect(c.extraArgs).toBeNull();
    });
});

describe('resolveHarnessTable', () => {
    it('lists every harness, published or not', () => {
        const table = resolveHarnessTable([{ id: 'pi', capabilities: { models: { pick: true, source: 'live' } } }, 'junk', null]);
        expect(Object.keys(table).sort()).toEqual([...HARNESS_IDS].sort());
        expect(table.pi.models.pick).toBe(true);
        expect(table.claude).toBe(FALLBACK_HARNESS_CAPABILITIES.claude);
    });
});
