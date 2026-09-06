import { describe, expect, it } from 'vitest';
import {
    getSessionRouteFromNotificationData,
    getSessionRouteFromNotificationResponse,
} from './notificationRouting';

describe('getSessionRouteFromNotificationData', () => {
    it('returns a session route when sessionId exists', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session-123' })).toBe('/session/session-123');
    });

    it('encodes session ids that contain spaces', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: 'session 123' })).toBe('/session/session%20123');
    });

    it('returns null when sessionId is missing', () => {
        expect(getSessionRouteFromNotificationData({ kind: 'done' })).toBeNull();
    });

    it('returns null for empty session ids', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: '   ' })).toBeNull();
    });

    it('uses a session url when present', () => {
        expect(getSessionRouteFromNotificationData({ url: '/session/session-123' })).toBe('/session/session-123');
    });

    // #438: a lone surrogate makes encodeURIComponent throw URIError.
    it('returns null instead of throwing for a malformed sessionId', () => {
        expect(getSessionRouteFromNotificationData({ sessionId: '\ud800' })).toBeNull();
        expect(getSessionRouteFromNotificationData(JSON.stringify({ sessionId: '\ud800' }))).toBeNull();
    });

    it('falls back to a valid sessionId when the url contains malformed Unicode', () => {
        expect(getSessionRouteFromNotificationData({ url: '/session/\ud800', sessionId: 'session-123' })).toBe('/session/session-123');
    });
});

describe('getSessionRouteFromNotificationResponse', () => {
    it('reads the route from content data', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {
                        data: { sessionId: 'session-123' }
                    }
                }
            }
        })).toBe('/session/session-123');
    });

    it('does not throw on malformed Unicode in the response (#438)', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: { request: { content: { data: { sessionId: '\ud800' } } } }
        })).toBeNull();
    });

    it('returns null when content data is missing', () => {
        expect(getSessionRouteFromNotificationResponse({
            notification: {
                request: {
                    content: {}
                }
            }
        })).toBeNull();
    });
});
