import { describe, expect, it } from 'vitest';
import {
    getAvailableModels,
    getAvailablePermissionModes,
    getCodexModelModes,
    getClaudePermissionModes,
    getDefaultEffortKey,
    getDefaultModelKey,
    getDefaultPermissionModeKey,
    mapMetadataOptions,
    resolveCurrentOption,
} from './modelModeOptions';

const translate = (key: string) => `tr:${key}`;

describe('modelModeOptions', () => {
    it('maps metadata option shape into mode options', () => {
        expect(mapMetadataOptions([
            { code: 'm1', value: 'Model One', description: 'Primary model' },
            { code: 'm2', value: 'Model Two' },
        ])).toEqual([
            { key: 'm1', name: 'Model One', description: 'Primary model' },
            { key: 'm2', name: 'Model Two', description: null },
        ]);
    });

    it('builds claude permission fallbacks with translated names', () => {
        const modes = getClaudePermissionModes(translate);
        expect(modes.map((mode) => mode.key)).toEqual(['default', 'plan', 'dontAsk', 'acceptEdits', 'bypassPermissions']);
        expect(modes[0].name).toBe('tr:agentInput.permissionMode.default');
    });

    it('builds codex model fallbacks', () => {
        const models = getCodexModelModes();
        expect(models.map((model) => model.key)).toEqual([
            'default',
            'gpt-5.5',
            'gpt-5.4',
            'gpt-5.3-codex',
            'gpt-5.2-codex',
            'gpt-5.1-codex-max',
            'gpt-5.2',
            'gpt-5.1-codex-mini',
        ]);
        expect(models[0].name).toBe('default model');
        expect(models[1].name).toBe('gpt-5.5');
    });

    it('uses code defaults for agent defaults', () => {
        expect(getDefaultPermissionModeKey('claude')).toBe('bypassPermissions');
        expect(getDefaultModelKey('claude')).toBe('fable');
        // Claude pins no effort — null defers to the CLI's own DEFAULT_CLAUDE_EFFORT
        // ('medium'), mirroring `claude --model fable` run on its own.
        expect(getDefaultEffortKey('claude')).toBeNull();
        expect(getDefaultPermissionModeKey('codex')).toBe('yolo');
        expect(getDefaultModelKey('codex')).toBe('gpt-5.6-sol');
        expect(getDefaultEffortKey('codex')).toBe('medium');
    });

    it('prefers metadata models over hardcoded fallbacks', () => {
        const models = getAvailableModels('gemini', {
            models: [
                { code: 'custom-gemini', value: 'Gemini Custom', description: 'From metadata' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'custom-gemini', name: 'Gemini Custom', description: 'From metadata' },
        ]);
    });

    it('adds codex default model option when metadata models are present', () => {
        const models = getAvailableModels('codex', {
            models: [
                { code: 'gpt-5.4', value: 'gpt-5.4', description: 'Latest' },
            ],
        } as any, translate);

        expect(models).toEqual([
            { key: 'default', name: 'default model', description: null },
            { key: 'gpt-5.4', name: 'gpt-5.4', description: 'Latest' },
        ]);
    });

    it('keeps codex permission modes hardcoded even when metadata modes exist', () => {
        const modes = getAvailablePermissionModes('codex', {
            operatingModes: [{ code: 'metadata-only', value: 'Metadata Mode', description: null }],
        } as any, translate);

        expect(modes.map((mode) => mode.key)).toEqual(['default', 'read-only', 'safe-yolo', 'yolo']);
    });

    it('applies hacks to metadata-provided operating modes', () => {
        const modes = getAvailablePermissionModes('gemini', {
            operatingModes: [
                { code: 'build', value: 'build, build', description: 'Do build steps' },
                { code: 'plan', value: 'plan/plan', description: 'Plan first' },
            ],
        } as any, translate);

        expect(modes).toEqual([
            { key: 'build', name: 'build', description: 'Do build steps' },
            { key: 'plan', name: 'plan', description: 'Plan first' },
        ]);
    });

    it('resolves the first matching preferred key', () => {
        const options = [
            { key: 'a', name: 'A' },
            { key: 'b', name: 'B' },
        ];

        expect(resolveCurrentOption(options, ['missing', 'b', 'a'])).toEqual({ key: 'b', name: 'B' });
        expect(resolveCurrentOption(options, ['missing'])).toBeNull();
    });
});

// #267: the fallback catalog must contain the flavor's configured default (and
// the session's current model) or the default cannot be resolved/re-selected.
describe('getAvailableModels fallback consistency (#267)', () => {
    it('includes the configured default model for claude and codex', () => {
        const claude = getAvailableModels('claude', null, translate);
        expect(claude.map((m) => m.key)).toContain(getDefaultModelKey('claude'));
        expect(resolveCurrentOption(claude, [getDefaultModelKey('claude')])).not.toBeNull();
        // Inserted right after 'default' so the list still leads with it.
        expect(claude[0].key).toBe('default');
        expect(claude[1].key).toBe('fable');

        const codex = getAvailableModels('codex', undefined, translate);
        expect(codex.map((m) => m.key)).toContain('gpt-5.6-sol');
        expect(codex[0].key).toBe('default');
    });

    it('keeps the current model selectable when the catalog lacks it', () => {
        const models = getAvailableModels('claude', null, translate, 'opus-4.9-preview');
        expect(models.map((m) => m.key)).toContain('opus-4.9-preview');
        expect(getAvailableModels('claude', null, translate, 'opus').filter((m) => m.key === 'opus')).toHaveLength(1);
    });

    it('leaves a metadata catalog untouched', () => {
        const models = getAvailableModels('claude', { models: [{ code: 'x', value: 'X' }] } as any, translate, 'fable');
        expect(models).toEqual([{ key: 'x', name: 'X', description: null }]);
    });
});
