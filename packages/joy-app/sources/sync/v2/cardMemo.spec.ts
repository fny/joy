import { describe, it, expect } from 'vitest';
import { CardMemo } from './cardMemo';

const row = (id: string, env: string | null, ct: string | null) => ({ sessionId: id, sessionKeyEnvelope: env, encryptedMetadata: ct });

describe('CardMemo', () => {
    it('misses a row it has never seen, then hits the same bytes', () => {
        const m = new CardMemo<string>();
        expect(m.lookup(row('a', 'env1', 'ct1'))).toEqual({ hit: false });
        m.remember(row('a', 'env1', 'ct1'), 'plain');
        expect(m.lookup(row('a', 'env1', 'ct1'))).toEqual({ hit: true, value: 'plain' });
        expect(m.hits).toBe(1);
        expect(m.misses).toBe(1);
    });

    it('misses when the card changed', () => {
        const m = new CardMemo<string>();
        m.remember(row('a', 'env1', 'ct1'), 'plain');
        expect(m.lookup(row('a', 'env1', 'ct2'))).toEqual({ hit: false });
    });

    it('misses when the key envelope changed — a rotation re-enveloped it', () => {
        const m = new CardMemo<string>();
        m.remember(row('a', 'env1', 'ct1'), 'plain');
        expect(m.lookup(row('a', 'env2', 'ct1'))).toEqual({ hit: false });
    });

    it('treats null and undefined as the same absence', () => {
        const m = new CardMemo<string>();
        m.remember({ sessionId: 'a', sessionKeyEnvelope: undefined, encryptedMetadata: undefined }, 'stub');
        expect(m.lookup(row('a', null, null))).toEqual({ hit: true, value: 'stub' });
    });

    it('remembers a failure too — the same bytes fail the same way', () => {
        const m = new CardMemo<string | null>();
        m.remember(row('a', 'env1', 'bad'), null);
        expect(m.lookup(row('a', 'env1', 'bad'))).toEqual({ hit: true, value: null });
    });

    it('prunes rows the relay no longer lists', () => {
        const m = new CardMemo<string>();
        m.remember(row('a', 'e', 'c'), 'A');
        m.remember(row('b', 'e', 'c'), 'B');
        m.prune(['b']);
        expect(m.size).toBe(1);
        expect(m.lookup(row('a', 'e', 'c'))).toEqual({ hit: false });
        expect(m.lookup(row('b', 'e', 'c'))).toEqual({ hit: true, value: 'B' });
    });

    it('an idle poll of N unchanged rows is N hits and no misses', () => {
        const m = new CardMemo<number>();
        const rows = Array.from({ length: 200 }, (_, i) => row(`s${i}`, `env${i}`, `ct${i}`));
        for (const r of rows) m.remember(r, 1);
        m.hits = 0; m.misses = 0;
        for (const r of rows) m.lookup(r);
        expect(m.hits).toBe(200);
        expect(m.misses).toBe(0);
    });
});
