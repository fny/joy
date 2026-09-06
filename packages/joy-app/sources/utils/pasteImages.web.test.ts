import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileToAttachmentPreview } from './pasteImages.web';

// A fake <img> whose load outcome is scripted per test; node has no Image.
type Outcome = 'load' | 'error' | 'hang';
let outcome: Outcome = 'load';
class FakeImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    naturalWidth = 4;
    naturalHeight = 3;
    set src(_v: string) {
        if (outcome === 'hang') return;
        setTimeout(() => (outcome === 'load' ? this.onload?.() : this.onerror?.()), 0);
    }
}

const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
    created.length = 0;
    revoked.length = 0;
    vi.stubGlobal('Image', FakeImage);
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => { const u = `blob:test/${created.length}`; created.push(u); return u; });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((u: string) => { revoked.push(u); });
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' });

describe('fileToAttachmentPreview (#440)', () => {
    it('hands the caller the object URL on success (the caller owns it)', async () => {
        outcome = 'load';
        const preview = await fileToAttachmentPreview(file, async () => 'hash');
        expect(preview).toMatchObject({ uri: 'blob:test/0', width: 4, height: 3, thumbhash: 'hash' });
        expect(revoked).toEqual([]);
    });

    it('revokes the object URL when the image fails to load', async () => {
        outcome = 'error';
        expect(await fileToAttachmentPreview(file, async () => undefined)).toBeNull();
        expect(created).toEqual(['blob:test/0']);
        expect(revoked).toEqual(['blob:test/0']);
    });

    it('revokes the object URL when thumbhash generation rejects', async () => {
        outcome = 'load';
        expect(await fileToAttachmentPreview(file, async () => { throw new Error('boom'); })).toBeNull();
        expect(revoked).toEqual(['blob:test/0']);
    });

    it('revokes the object URL when the load times out', async () => {
        vi.useFakeTimers();
        outcome = 'hang';
        const p = fileToAttachmentPreview(file, async () => undefined);
        await vi.advanceTimersByTimeAsync(5001);
        expect(await p).toBeNull();
        expect(revoked).toEqual(['blob:test/0']);
    });
});
