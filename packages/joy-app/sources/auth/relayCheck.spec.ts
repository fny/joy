import { describe, it, expect, vi } from 'vitest';

vi.mock('@/modal', () => ({ Modal: { prompt: vi.fn() } }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/sync/serverConfig', () => ({
    relayAccessKeyHeaders: () => ({}),
    relayNameForUrl: (u: string) => u,
    setRelayAccessKey: vi.fn(),
    validateServerUrl: (u: string) => (/^https?:\/\/.+/.test(u) ? { valid: true } : { valid: false, error: 'bad' }),
}));

import { normalizeRelayInput, probeRelay } from './relayCheck';

describe('normalizeRelayInput', () => {
    it('gives a bare host its scheme and drops a trailing slash', () => {
        expect(normalizeRelayInput('relay.example.test:4997')).toBe('https://relay.example.test:4997');
        expect(normalizeRelayInput('  https://relay.example.test/  ')).toBe('https://relay.example.test');
        expect(normalizeRelayInput('http://127.0.0.1:3105')).toBe('http://127.0.0.1:3105');
        expect(normalizeRelayInput('   ')).toBe('');
    });
});

describe('probeRelay', () => {
    it('reads the capabilities answer: a joy relay, a gate, something else, nothing', async () => {
        const answer = (status: number, body?: unknown) => vi.fn(async () => ({ status, ok: status < 300, json: async () => body })) as unknown as typeof fetch;
        globalThis.fetch = answer(200, { relay: 'joy-relay' });
        expect(await probeRelay('https://relay.example.test')).toBe('ok');
        globalThis.fetch = answer(401);
        expect(await probeRelay('https://relay.example.test')).toBe('gated');
        globalThis.fetch = answer(200, { relay: 'something-else' });
        expect(await probeRelay('https://relay.example.test')).toBe('not_relay');
        globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
        expect(await probeRelay('https://relay.example.test')).toBe('unreachable');
    });
});
