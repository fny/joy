import { describe, it, expect } from 'vitest';
import { describePaneError } from './paneError';

describe('describePaneError', () => {
    it('returns null when there is no error', () => {
        expect(describePaneError(null)).toBeNull();
        expect(describePaneError(undefined)).toBeNull();
        expect(describePaneError('')).toBeNull();
    });

    // REGRESSION: a session the daemon does not know was rendered as
    // "session_not_found — retrying…" above an empty pane, forever. Reported as
    // "nothing shows up in the terminal view" — the view looked like it was
    // still loading when in fact nothing would ever arrive.
    it('treats a missing session as terminal, not as retrying', () => {
        const r = describePaneError('session_not_found')!;
        expect(r.kind).toBe('gone');
        expect(r.message).not.toMatch(/retrying/i);
        expect(r.message).toMatch(/no longer running/i);
    });

    it('matches the daemon code however it is wrapped', () => {
        for (const raw of ['session_not_found', 'Error: session_not_found', 'HTTP 404 not_found', 'No such session']) {
            expect(describePaneError(raw)!.kind).toBe('gone');
        }
    });

    // The other way a terminal renders blank: the app has no machine-plane
    // context, so both the v2 tunnel and the v1 RPC fail. Saying "retrying"
    // there is equally false.
    it('treats a missing machine key as terminal', () => {
        const r = describePaneError('Machine encryption not found for dde106b3-bef7-4bf9')!;
        expect(r.kind).toBe('gone');
        expect(r.message).not.toMatch(/retrying/i);
    });

    it('keeps genuinely transient failures on the retry banner', () => {
        for (const raw of ['timeout', 'socket disconnected', 'tmux capture failed']) {
            const r = describePaneError(raw)!;
            expect(r.kind).toBe('transient');
            expect(r.message).toContain(raw);
            expect(r.message).toMatch(/retrying/i);
        }
    });
});
