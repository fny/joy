import { describe, expect, it } from 'vitest';
import { isHttpMarkdownLink } from './linkUtils';

describe('isHttpMarkdownLink', () => {
    it('accepts http and https links', () => {
        expect(isHttpMarkdownLink('http://example.com')).toBe(true);
        expect(isHttpMarkdownLink('https://example.com/docs')).toBe(true);
        expect(isHttpMarkdownLink(' HTTPS://example.com/docs ')).toBe(true);
    });

    it('rejects non-http schemes and path-like targets', () => {
        expect(isHttpMarkdownLink('mailto:test@example.com')).toBe(false);
        expect(isHttpMarkdownLink('data:text/plain,hello')).toBe(false);
        expect(isHttpMarkdownLink('/Users/me/project/file.ts')).toBe(false);
        expect(isHttpMarkdownLink('packages/joy-app/index.tsx')).toBe(false);
    });
});

import { markdownImageHost } from './linkUtils';

describe('markdownImageHost (#94)', () => {
    it('returns the host of an http(s) image URL', () => {
        expect(markdownImageHost('https://cdn.example.com/a.png?x=1')).toBe('cdn.example.com');
        expect(markdownImageHost(' http://localhost:8080/p.png ')).toBe('localhost:8080');
    });

    it('is null for anything that must never be fetched automatically', () => {
        expect(markdownImageHost('file:///etc/passwd')).toBeNull();
        expect(markdownImageHost('data:image/png;base64,AAAA')).toBeNull();
        expect(markdownImageHost('/Users/me/shot.png')).toBeNull();
        expect(markdownImageHost('https://')).toBeNull();
    });
});
