import { describe, it, expect } from 'vitest';
import { findMissingAttachments, liveAttachments } from './draftAttachments';

const a = (uri: string) => ({ uri });
const gone = (...dead: string[]) => async (uri: string) => !dead.includes(uri);

describe('findMissingAttachments', () => {
    it('reports the files that are gone', async () => {
        const missing = await findMissingAttachments(
            [a('file:///c/one.jpg'), a('file:///c/two.jpg')],
            gone('file:///c/two.jpg'),
        );
        expect(missing).toEqual(['file:///c/two.jpg']);
    });

    it('reports nothing when every file is present', async () => {
        expect(await findMissingAttachments([a('file:///c/one.jpg')], gone())).toEqual([]);
        expect(await findMissingAttachments([], gone())).toEqual([]);
        expect(await findMissingAttachments(undefined, gone())).toEqual([]);
    });

    it('never calls a URI dead that it cannot check', async () => {
        // blob:/data: are page-held; content:// needs a resolver, not a stat.
        // Claiming these are missing would cry wolf on every draft.
        const uris = [a('blob:abc'), a('data:image/png;base64,xx'), a('content://media/1')];
        expect(await findMissingAttachments(uris, async () => false)).toEqual([]);
    });

    it('treats a failed stat as present — an error is not proof of absence', async () => {
        const throwing = async () => { throw new Error('EIO'); };
        expect(await findMissingAttachments([a('file:///c/one.jpg')], throwing)).toEqual([]);
    });

    it('checks bare absolute paths too', async () => {
        expect(await findMissingAttachments([a('/cache/one.jpg')], gone('/cache/one.jpg')))
            .toEqual(['/cache/one.jpg']);
    });
});

describe('liveAttachments', () => {
    it('drops only the dead ones', () => {
        const all = [a('one'), a('two'), a('three')];
        expect(liveAttachments(all, ['two']).map((x) => x.uri)).toEqual(['one', 'three']);
    });

    it('returns everything when nothing is missing', () => {
        expect(liveAttachments([a('one'), a('two')], [])).toHaveLength(2);
        expect(liveAttachments([a('one'), a('two')], undefined)).toHaveLength(2);
    });

    it('can return nothing when every attachment died', () => {
        expect(liveAttachments([a('one')], ['one'])).toEqual([]);
    });

    it('handles an absent list', () => {
        expect(liveAttachments(undefined, ['one'])).toEqual([]);
    });
});
