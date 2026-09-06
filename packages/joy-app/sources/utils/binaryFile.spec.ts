import { describe, it, expect } from 'vitest';
import { fileExtension, isBinaryPath, isImagePath } from './binaryFile';

describe('fileExtension', () => {
    it('needs a real separator inside the basename (#422)', () => {
        expect(fileExtension('a')).toBe('');
        expect(fileExtension('key')).toBe('');
        expect(fileExtension('png')).toBe('');
        expect(fileExtension('dir/png')).toBe('');
        expect(fileExtension('.env')).toBe('');
        expect(fileExtension('foo.')).toBe('');
    });

    it('takes the last extension of the basename, lower-cased, on either separator', () => {
        expect(fileExtension('x.PNG')).toBe('png');
        expect(fileExtension('archive.tar.gz')).toBe('gz');
        expect(fileExtension('C:\\x\\y.JPG')).toBe('jpg');
        expect(fileExtension('a.b/c')).toBe('');
    });
});

describe('isBinaryPath / isImagePath (#422)', () => {
    it('extensionless root files named like extensions are text', () => {
        for (const name of ['a', 'key', 'png', 'so', 'o']) {
            expect(isBinaryPath(name)).toBe(false);
            expect(isImagePath(name)).toBe(false);
        }
    });

    it('real extensions still classify, and ./png agrees with png', () => {
        expect(isBinaryPath('lib/a.so')).toBe(true);
        expect(isImagePath('shot.png')).toBe(true);
        expect(isBinaryPath('shot.png')).toBe(true);
        expect(isBinaryPath('icon.svg')).toBe(false);
        expect(isBinaryPath('./png')).toBe(false);
    });
});
