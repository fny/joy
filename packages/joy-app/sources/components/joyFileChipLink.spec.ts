import { describe, it, expect } from 'vitest';
import { encodePathParam, decodePathParam } from '@/utils/pathParam';

// #650: the <joy-file> chip built its link with a PLAIN path while the viewer
// decodes with decodePathParam. These pin the round trip the chip depends on.
describe('file viewer path param round trip', () => {
    const paths = [
        '/home/ubuntu/Workspace/bitlevel-wrapper/dist/bitlevel-rocky8-222h.tar.gz',
        '/tmp/a file with spaces.md',
        '/tmp/résumé.md',
        '/tmp/emoji-🎉.txt',
        '/a/b/c.d.e.f',
    ];

    it('survives encode → decode for real paths', () => {
        for (const p of paths) {
            expect(decodePathParam(encodePathParam(p))).toBe(p);
        }
    });

    it('an UNENCODED path decodes to empty — the bug the chip had', () => {
        // This is why the viewer said "path required": not a bad path, no path.
        const plain = '/home/ubuntu/Workspace/bitlevel-wrapper/dist/bitlevel-rocky8-222h.tar.gz';
        expect(decodePathParam(plain)).toBe('');
    });

    it('an empty param decodes to empty rather than throwing', () => {
        expect(decodePathParam('')).toBe('');
    });
});
