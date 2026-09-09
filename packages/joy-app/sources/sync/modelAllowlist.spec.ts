import { describe, expect, it } from 'vitest';
import { enabledModels } from './modelAllowlist';

const catalog = [
    { key: 'a', recommended: true, isDefault: true },
    { key: 'b', recommended: true },
    { key: 'c' },
    { key: 'd' },
];

describe('enabledModels', () => {
    it('no stored list: the recommended subset', () => {
        expect(enabledModels(catalog, undefined).map((m) => m.key)).toEqual(['a', 'b']);
    });

    it('no stored list and nothing recommended: the whole catalog', () => {
        const plain = catalog.map(({ key, isDefault }) => ({ key, isDefault }));
        expect(enabledModels(plain, undefined).map((m) => m.key)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('a stored list: exactly those, in catalog order, plus the default', () => {
        expect(enabledModels(catalog, ['d', 'c']).map((m) => m.key)).toEqual(['a', 'c', 'd']);
    });

    it('a stored list that matches nothing falls back to recommended, never an empty picker', () => {
        expect(enabledModels(catalog, ['gone']).map((m) => m.key)).toEqual(['a', 'b']);
    });

    it('the model in use is always offered, even when disabled', () => {
        expect(enabledModels(catalog, ['b'], 'd').map((m) => m.key)).toEqual(['a', 'b', 'd']);
        expect(enabledModels(catalog, undefined, 'c').map((m) => m.key)).toEqual(['a', 'b', 'c']);
    });

    it('an empty catalog stays empty', () => {
        expect(enabledModels([], ['a'], 'a')).toEqual([]);
    });
});
