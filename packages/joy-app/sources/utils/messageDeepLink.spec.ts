import { describe, it, expect } from 'vitest';
import { deepLinkStep, MAX_DEEP_LINK_PAGES } from './messageDeepLink';

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
});
