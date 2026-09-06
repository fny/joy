import { describe, it, expect } from 'vitest';
import { deepLinkStep, deepLinkTarget, MAX_DEEP_LINK_PAGES } from './messageDeepLink';

describe('deepLinkStep (#165)', () => {
    const base = { messagesLoaded: true, found: false, hasMoreOlder: false, isLoadingOlder: false, pagesRequested: 0 };

    it('shows the message the moment it is present, whatever else is going on', () => {
        expect(deepLinkStep({ ...base, found: true, messagesLoaded: false })).toBe('show');
        expect(deepLinkStep({ ...base, found: true, isLoadingOlder: true })).toBe('show');
    });

    it('waits for the first page and for an in-flight older page', () => {
        expect(deepLinkStep({ ...base, messagesLoaded: false })).toBe('wait');
        expect(deepLinkStep({ ...base, hasMoreOlder: true, isLoadingOlder: true })).toBe('wait');
    });

    it('pages older history instead of leaving while more history exists', () => {
        expect(deepLinkStep({ ...base, hasMoreOlder: true })).toBe('loadOlder');
    });

    it('leaves only once history is exhausted', () => {
        expect(deepLinkStep({ ...base, hasMoreOlder: false })).toBe('back');
    });

    it('stops paging after the safety cap even if the store keeps claiming more', () => {
        expect(deepLinkStep({ ...base, hasMoreOlder: true, pagesRequested: MAX_DEEP_LINK_PAGES })).toBe('back');
    });

    it('a failed page request waits for a retry instead of leaving or consuming the budget (#165 residual)', () => {
        expect(deepLinkStep({ ...base, hasMoreOlder: true, pagingFailed: true })).toBe('retry');
        // Retrying clears the failure; the same budget position is used again.
        expect(deepLinkStep({ ...base, hasMoreOlder: true, pagesRequested: 3, pagingFailed: false })).toBe('loadOlder');
        // A found message wins even over a stale failure.
        expect(deepLinkStep({ ...base, found: true, pagingFailed: true })).toBe('show');
    });

    it('the page budget is keyed by link target so a new link starts over', () => {
        expect(deepLinkTarget('s1', 'm1')).not.toBe(deepLinkTarget('s1', 'm2'));
        expect(deepLinkTarget('s1', 'm1')).toBe(deepLinkTarget('s1', 'm1'));
    });
});
