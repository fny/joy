import { describe, it, expect } from 'vitest';
import { v2LinkForRow } from './sessionLink';

describe('v2LinkForRow (#409)', () => {
    const row = { sessionId: 'v2-1', sessionKeyEnvelope: 'env', localSessionId: 'local-1' };

    it('stamps the relay the list was fetched from, not the app server URL', () => {
        const link = v2LinkForRow(row, { relay: 'https://a.example', keyEnvelope: 'old' }, 'https://b.example');
        expect(link.relay).toBe('https://b.example');
    });

    it('the row is authoritative for linkage; the card only fills gaps', () => {
        const link = v2LinkForRow(row, { sessionId: 'stale', keyEnvelope: 'old', localSessionId: 'stale-local' }, 'https://b.example');
        expect(link).toEqual({ sessionId: 'v2-1', relay: 'https://b.example', keyEnvelope: 'env', localSessionId: 'local-1' });
    });

    it('falls back to the card for fields the row lacks', () => {
        const link = v2LinkForRow({ sessionId: 'v2-1' }, { keyEnvelope: 'card-env', localSessionId: 'card-local' }, 'https://b.example');
        expect(link.keyEnvelope).toBe('card-env');
        expect(link.localSessionId).toBe('card-local');
    });

    it('with no card at all yields an empty envelope', () => {
        const link = v2LinkForRow({ sessionId: 'v2-1', sessionKeyEnvelope: null, localSessionId: null }, undefined, 'https://b.example');
        expect(link).toEqual({ sessionId: 'v2-1', relay: 'https://b.example', keyEnvelope: '', localSessionId: undefined });
    });
});
