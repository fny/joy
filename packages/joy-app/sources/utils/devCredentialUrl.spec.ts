import { describe, it, expect } from 'vitest';
import { stripDevCredentialParams } from './devCredentialUrl';

describe('stripDevCredentialParams (#185)', () => {
    it('removes only dev_token/dev_secret and keeps the fragment', () => {
        expect(stripDevCredentialParams('http://localhost:8081/terminal/connect?dev_token=t&dev_secret=s#key=abc'))
            .toBe('/terminal/connect#key=abc');
    });

    it('keeps unrelated query parameters', () => {
        expect(stripDevCredentialParams('http://h/x?dev_token=t&keep=1&dev_secret=s&also=2#f'))
            .toBe('/x?keep=1&also=2#f');
    });

    it('is a no-op when no dev params are present', () => {
        expect(stripDevCredentialParams('http://h/session/1?tab=files#top')).toBe('/session/1?tab=files#top');
    });
});
