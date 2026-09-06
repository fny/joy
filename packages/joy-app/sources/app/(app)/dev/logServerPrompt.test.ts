import { describe, it, expect } from 'vitest';
import { logServerPromptOutcome } from './logServerPrompt';

describe('logServerPromptOutcome (#138)', () => {
    it('a cancelled prompt (null) keeps the configured server, never disables logging', () => {
        expect(logServerPromptOutcome(null, 'http://192.168.1.5:8787')).toEqual({ kind: 'cancelled' });
        expect(logServerPromptOutcome(undefined, 'http://192.168.1.5:8787')).toEqual({ kind: 'cancelled' });
    });

    it('a submitted empty field is the explicit clear', () => {
        expect(logServerPromptOutcome('', 'http://192.168.1.5:8787')).toEqual({ kind: 'disable' });
        expect(logServerPromptOutcome('   ', 'http://192.168.1.5:8787')).toEqual({ kind: 'disable' });
    });

    it('resubmitting the current value changes nothing; a new value is set', () => {
        expect(logServerPromptOutcome('http://a:1', 'http://a:1')).toEqual({ kind: 'unchanged' });
        expect(logServerPromptOutcome('http://b:2', 'http://a:1')).toEqual({ kind: 'set', url: 'http://b:2' });
    });

    it('cancelling with nothing configured is not a clear either', () => {
        expect(logServerPromptOutcome(null, '')).toEqual({ kind: 'cancelled' });
        expect(logServerPromptOutcome('', '')).toEqual({ kind: 'unchanged' });
    });
});
