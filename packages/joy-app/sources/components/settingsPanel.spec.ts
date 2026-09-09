import { describe, expect, it } from 'vitest';
import {
    canGoBack,
    initialLevel,
    levelAfterSelect,
    selectedName,
    visibleSections,
    type SettingsSection,
} from './settingsPanel';

const section = (over: Partial<SettingsSection> & Pick<SettingsSection, 'level'>): SettingsSection => ({
    label: 'Label',
    title: 'TITLE',
    options: [{ key: 'a', name: 'Ay' }, { key: 'b', name: 'Bee' }],
    selectedKey: 'a',
    ...over,
});

const permission = section({ level: 'permission', label: 'Permission mode' });
const model = section({ level: 'model', label: 'Model' });
const effort = section({ level: 'effort', label: 'Effort' });

describe('visibleSections', () => {
    it('drops a section with nothing to choose from', () => {
        const empty = section({ level: 'permission', options: [] });
        expect(visibleSections([empty, model]).map((s) => s.level)).toEqual(['model']);
    });
});

describe('selectedName', () => {
    it('names the selected option', () => {
        expect(selectedName(model)).toBe('Ay');
    });

    it('falls back to the raw key when the app has no name for it — a daemon offering a mode this build predates', () => {
        expect(selectedName(section({ level: 'model', selectedKey: 'zeta' }))).toBe('zeta');
    });

    it('is null when nothing is selected', () => {
        expect(selectedName(section({ level: 'model', selectedKey: null }))).toBeNull();
    });
});

describe('initialLevel', () => {
    it('opens at the root when there is more than one setting', () => {
        expect(initialLevel([permission, model, effort])).toBe('root');
    });

    it('opens the only section directly — a one-row root is a tap tax', () => {
        expect(initialLevel([section({ level: 'permission', options: [] }), model])).toBe('model');
    });

    it('a panel with nothing to offer still resolves to the root', () => {
        expect(initialLevel([section({ level: 'model', options: [] })])).toBe('root');
    });
});

describe('canGoBack', () => {
    it('is false at the root', () => {
        expect(canGoBack([permission, model], 'root')).toBe(false);
    });

    it('is true inside a section when a root exists', () => {
        expect(canGoBack([permission, model], 'model')).toBe(true);
    });

    it('is false when the single section IS the panel', () => {
        expect(canGoBack([model], 'model')).toBe(false);
    });
});

describe('levelAfterSelect', () => {
    it('returns to the root, so model and effort are one visit', () => {
        expect(levelAfterSelect([permission, model, effort], 'model')).toBe('root');
    });

    it('closes when there is no root to return to', () => {
        expect(levelAfterSelect([model], 'model')).toBe('close');
    });
});
