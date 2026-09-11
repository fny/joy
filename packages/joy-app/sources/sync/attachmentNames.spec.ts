import { describe, it, expect } from 'vitest';
import { attachmentDisplayName, stripUploadPrefix } from './attachmentNames';

describe('attachmentDisplayName', () => {
    it('shows the name the source gave, else the word the daemon names it after', () => {
        expect(attachmentDisplayName({ name: 'report.pdf', source: 'document' })).toBe('report.pdf');
        expect(attachmentDisplayName({ name: '', source: 'paste', mimeType: 'image/jpeg' })).toBe('paste.jpg');
        expect(attachmentDisplayName({ name: '', source: 'library', mimeType: 'image/jpeg' })).toBe('photo.jpg');
        expect(attachmentDisplayName({ name: '', source: 'document', mimeType: 'application/pdf' })).toBe('file.pdf');
        expect(attachmentDisplayName({ name: '', source: 'drop' })).toBe('drop');
        expect(attachmentDisplayName({ name: '' })).toBe('unknown');
    });
});

describe('stripUploadPrefix', () => {
    it('drops the upload prefix and leaves every other name alone', () => {
        expect(stripUploadPrefix('20260911-162140-0000.image.png')).toBe('image.png');
        expect(stripUploadPrefix('20260911-162140-0001.v1.2.notes.txt')).toBe('v1.2.notes.txt');
        expect(stripUploadPrefix('report.pdf')).toBe('report.pdf');
        expect(stripUploadPrefix('2026-09-11.log')).toBe('2026-09-11.log');
    });
});
