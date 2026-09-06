import { describe, it, expect, vi } from 'vitest';

vi.mock('expo-crypto', () => { let n = 0; return { randomUUID: () => `uuid-${++n}` }; });

import { beginSend, sendSucceeded, sendFailed } from './sendKey';

describe('sendKey — relay idempotency keys', () => {
    it('two identical messages in flight never share a key', () => {
        const a = beginSend('s1', 'hello');
        const b = beginSend('s1', 'hello');
        expect(a).not.toBe(b);
    });
    it('an exact retry of a FAILED send reuses its key; an edited retry does not', () => {
        const k = beginSend('s2', 'draft text', ['att1']);
        sendFailed('s2', k);
        expect(beginSend('s2', 'draft text', ['att1'])).toBe(k);       // unchanged → replay
        sendFailed('s2', k);
        expect(beginSend('s2', 'draft text edited', ['att1'])).not.toBe(k); // edited → new message
        expect(beginSend('s2', 'draft text', [])).not.toBe(k);            // attachments changed → new message
    });
    it('a successful send is forgotten: the same text later is a new message', () => {
        const k = beginSend('s3', 'again');
        sendSucceeded('s3', k);
        expect(beginSend('s3', 'again')).not.toBe(k);
    });
    it('one failed payload is retained independently of another scope\'s success', () => {
        const kb = beginSend('s4', 'B');
        sendFailed('s4', kb);
        const ka = beginSend('s5', 'A');
        sendSucceeded('s5', ka);
        expect(beginSend('s4', 'B')).toBe(kb);
    });
    it('a later successful send in the same scope ends an older failure\'s retry candidacy', () => {
        const ka = beginSend('s6', 'A');
        sendFailed('s6', ka);                 // A restored into the composer…
        const kb = beginSend('s6', 'B');      // …replaced with B and sent
        sendSucceeded('s6', kb);
        expect(beginSend('s6', 'A')).not.toBe(ka); // typing A again is a new message
    });
});
