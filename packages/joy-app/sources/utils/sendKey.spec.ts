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
    it('a concurrent send\'s late success keeps a failure that happened after it began', () => {
        const ka = beginSend('s7', 'A');
        const kb = beginSend('s7', 'B');        // both in flight
        sendFailed('s7', kb);                   // B's ack was lost → restored
        sendSucceeded('s7', ka);                // A's delayed success
        expect(beginSend('s7', 'B')).toBe(kb);  // unchanged B replays, no third command
    });
    it('a retried send counts as begun at the retry, so its success retires older failures', () => {
        const ka = beginSend('s9', 'A');
        const kb = beginSend('s9', 'B');        // A and B concurrent
        sendFailed('s9', ka); sendFailed('s9', kb); // both acks lost
        expect(beginSend('s9', 'B')).toBe(kb);  // user keeps B, retries it…
        sendSucceeded('s9', kb);                // …and it lands
        expect(beginSend('s9', 'A')).not.toBe(ka); // typing A again later is a new message
    });
    it('the per-scope cap evicts only failed entries', () => {
        const pending = beginSend('s8', 'keep');
        for (let i = 0; i < 60; i++) sendFailed('s8', beginSend('s8', `f${i}`));
        expect(beginSend('s8', 'f59')).not.toBe(pending);
        sendSucceeded('s8', pending);           // still known: no throw, no reuse
        expect(beginSend('s8', 'keep')).not.toBe(pending);
    });
});
