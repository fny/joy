import { describe, expect, it } from 'vitest';
import { mergeCopiedAccents } from './paletteCopy';

describe('mergeCopiedAccents (#251)', () => {
    it('keeps the user override over the preset accent', () => {
        expect(mergeCopiedAccents({ blue: '#0969da', green: '#1a7f37' }, { blue: '#123456' }))
            .toEqual({ blue: '#123456', green: '#1a7f37' });
    });

    it('adopts preset accents the user never overrode', () => {
        expect(mergeCopiedAccents({ blue: '#0969da' }, null)).toEqual({ blue: '#0969da' });
    });

    it('leaves overrides untouched when the preset ships no accents', () => {
        expect(mergeCopiedAccents(undefined, { blue: '#123456' })).toEqual({ blue: '#123456' });
        expect(mergeCopiedAccents(undefined, null)).toBeNull();
    });
});
