/**
 * What a message deep link should do next (#165).
 *
 * `/session/:id/message/:messageId` used to navigate back as soon as the
 * FIRST page of history had loaded without the message. After a restart the
 * first page is only the most recent window, so a link to an older tool
 * message was dismissed while the message still existed further back in the
 * transcript. Initial-page readiness is not proof of absence: page older
 * history until the message appears or history is exhausted.
 */
export type DeepLinkStep = 'wait' | 'show' | 'loadOlder' | 'back';

/** Hard stop so a paging loop that never advances cannot spin forever. */
export const MAX_DEEP_LINK_PAGES = 200;

export function deepLinkStep(input: {
    messagesLoaded: boolean;
    found: boolean;
    hasMoreOlder: boolean;
    isLoadingOlder: boolean;
    pagesRequested: number;
}): DeepLinkStep {
    if (input.found) return 'show';
    if (!input.messagesLoaded) return 'wait';
    if (input.isLoadingOlder) return 'wait';
    if (input.hasMoreOlder && input.pagesRequested < MAX_DEEP_LINK_PAGES) return 'loadOlder';
    return 'back';
}
