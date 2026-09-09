import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import type { SettingsSection } from './settingsPanel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { theme } = vi.hoisted(() => {
    const proxy: unknown = new Proxy({}, {
        get: (_t, key) => (key === Symbol.toPrimitive || key === 'toJSON' ? () => '#000' : proxy),
    });
    return { theme: proxy };
});

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('react-native-reanimated', () => ({
    default: { View: 'Animated.View' },
    useAnimatedStyle: (fn: () => unknown) => fn(),
    useSharedValue: (v: number) => ({ value: v }),
    withTiming: (v: number) => v,
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: unknown) => (typeof styles === 'function' ? styles(theme) : styles) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('./haptics', () => ({ hapticsLight: () => {} }));
vi.mock('./FloatingOverlay', () => ({ FloatingOverlay: 'FloatingOverlay' }));

import { SessionSettingsPanel } from './SessionSettingsPanel';

const SECTIONS: SettingsSection[] = [
    {
        level: 'permission', label: 'Permission mode', title: 'PERMISSION MODE',
        options: [{ key: 'bypassPermissions', name: 'yolo' }, { key: 'plan', name: 'plan' }],
        selectedKey: 'bypassPermissions',
    },
    {
        level: 'model', label: 'Model', title: 'MODEL',
        options: [{ key: 'opus', name: 'opus' }, { key: 'fable', name: 'fable' }],
        selectedKey: 'fable',
    },
    {
        level: 'effort', label: 'Effort', title: 'EFFORT',
        options: [{ key: 'low', name: 'low' }, { key: 'max', name: 'max' }],
        selectedKey: 'max',
    },
];

let onSelect: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

function render(sections = SECTIONS) {
    let r!: ReactTestRenderer;
    act(() => {
        r = TestRenderer.create(React.createElement(SessionSettingsPanel, {
            sections, onSelect, onClose, maxHeight: 320, backLabel: 'Back',
        }));
    });
    return r;
}

/** Every node that carries a testID — rows are Views, taps are Pressables.
 *  (These type defs expose findAllByType, not findAll.) */
const nodes = (r: ReactTestRenderer): ReactTestInstance[] => [
    ...r.root.findAllByType('View' as never),
    ...r.root.findAllByType('Pressable' as never),
];
const has = (r: ReactTestRenderer, testID: string): boolean =>
    nodes(r).some((n) => n.props?.testID === testID);
const press = (r: ReactTestRenderer, testID: string): void => {
    const node = nodes(r).find((n) => n.props?.testID === testID);
    if (!node) throw new Error(`no node with testID ${testID}`);
    act(() => { (node.props as { onPress: () => void }).onPress(); });
};
/** Option rows currently on screen, by option key. */
const optionLabels = (r: ReactTestRenderer): string[] =>
    nodes(r)
        .map((n) => n.props?.testID)
        .filter((id): id is string => typeof id === 'string' && id.startsWith('session-settings-option-'))
        .map((id) => id.replace('session-settings-option-', ''));

beforeEach(() => { onSelect = vi.fn(); onClose = vi.fn(); });

describe('SessionSettingsPanel', () => {
    it('opens on the root, one row per setting, and shows no options yet', () => {
        const r = render();
        expect(has(r, 'session-settings-root')).toBe(true);
        expect(has(r, 'session-settings-open-permission')).toBe(true);
        expect(has(r, 'session-settings-open-model')).toBe(true);
        expect(has(r, 'session-settings-open-effort')).toBe(true);
        expect(optionLabels(r)).toEqual([]);
    });

    it('drills into exactly one list — the whole point, versus three at once', () => {
        const r = render();
        press(r, 'session-settings-open-model');
        expect(optionLabels(r)).toEqual(['opus', 'fable']);
        expect(has(r, 'session-settings-root')).toBe(false);
        expect(has(r, 'session-settings-model')).toBe(true);
    });

    it('a choice applies the value and returns to the root, so model and effort are one visit', () => {
        const r = render();
        press(r, 'session-settings-open-model');
        press(r, 'session-settings-option-opus');
        expect(onSelect).toHaveBeenCalledWith('model', { key: 'opus', name: 'opus' });
        expect(onClose).not.toHaveBeenCalled();
        expect(has(r, 'session-settings-root')).toBe(true);
        // …and the next setting is one tap away.
        press(r, 'session-settings-open-effort');
        expect(optionLabels(r)).toEqual(['low', 'max']);
    });

    it('back returns to the root without applying anything', () => {
        const r = render();
        press(r, 'session-settings-open-permission');
        press(r, 'session-settings-back');
        expect(onSelect).not.toHaveBeenCalled();
        expect(has(r, 'session-settings-root')).toBe(true);
    });

    it('a section with no options is not offered a row', () => {
        const r = render([SECTIONS[0], { ...SECTIONS[1], options: [] }, SECTIONS[2]]);
        expect(has(r, 'session-settings-open-model')).toBe(false);
        expect(has(r, 'session-settings-open-permission')).toBe(true);
    });

    it('one section IS the panel: it opens directly, has no back, and a choice closes', () => {
        const r = render([SECTIONS[1]]);
        expect(has(r, 'session-settings-root')).toBe(false);
        expect(optionLabels(r)).toEqual(['opus', 'fable']);
        expect(has(r, 'session-settings-back')).toBe(false);
        press(r, 'session-settings-option-opus');
        expect(onSelect).toHaveBeenCalledWith('model', { key: 'opus', name: 'opus' });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
