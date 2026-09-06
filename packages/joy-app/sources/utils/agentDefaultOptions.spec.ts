import { describe, expect, it } from 'vitest';
import { isUnsupportedOverride, modelOptionsFor, permissionOptionsFor } from './agentDefaultOptions';
import type { AgentKey } from '@/sync/agentDefaults';

const claudeish = (agent: AgentKey) => {
    // Mirrors the generic helpers' fall-through: unknown agents get Claude's list.
    if (agent === 'codex') return [{ key: 'gpt-5.6-sol', name: 'GPT', description: null }];
    if (agent === 'openclaw') return [{ key: 'default', name: 'default model', description: null }];
    return [
        { key: 'default', name: 'Default', description: null },
        { key: 'opus', name: 'Opus', description: null },
        { key: 'sonnet', name: 'Sonnet', description: null },
    ];
};

describe('agent default option catalogues (#171)', () => {
    it('does not offer Claude models to OpenCode, Pi or Antigravity', () => {
        for (const agent of ['opencode', 'pi', 'agy'] as AgentKey[]) {
            expect(modelOptionsFor(agent, claudeish)).toEqual([]);
        }
    });

    it('offers no permission modes for agents without a permission surface', () => {
        for (const agent of ['opencode', 'pi', 'agy'] as AgentKey[]) {
            expect(permissionOptionsFor(agent, claudeish)).toEqual([]);
        }
    });

    it('keeps the real catalogues for Claude and Codex', () => {
        expect(modelOptionsFor('claude', claudeish).map((o) => o.key)).toEqual(['opus', 'sonnet']);
        expect(modelOptionsFor('codex', claudeish).map((o) => o.key)).toEqual(['gpt-5.6-sol']);
        expect(permissionOptionsFor('claude', claudeish).length).toBeGreaterThan(0);
    });

    it('flags an override the agent cannot honour', () => {
        expect(isUnsupportedOverride('opencode', 'modelMode', 'opus', [])).toBe(true);
        expect(isUnsupportedOverride('pi', 'permissionMode', 'bypassPermissions', [])).toBe(true);
        expect(isUnsupportedOverride('claude', 'modelMode', 'gpt-5.6-sol', claudeish('claude'))).toBe(true);
        expect(isUnsupportedOverride('claude', 'modelMode', 'opus', claudeish('claude'))).toBe(false);
        expect(isUnsupportedOverride('claude', 'modelMode', undefined, claudeish('claude'))).toBe(false);
    });
});
