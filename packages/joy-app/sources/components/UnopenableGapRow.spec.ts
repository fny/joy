import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { theme } = vi.hoisted(() => {
    const proxy: unknown = new Proxy({}, {
        get: (_target, key) => (key === Symbol.toPrimitive || key === 'toJSON' ? () => '#000' : proxy),
    });
    return { theme: proxy };
});

vi.mock('react-native', () => ({ View: 'View', Text: 'Text' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: unknown) => (typeof styles === 'function' ? styles(theme) : styles) },
}));
vi.mock('@/text', () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }));

import { UnopenableGapRow } from './UnopenableGapRow';

function render(count: number) {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(React.createElement(UnopenableGapRow, { count }));
    });
    return renderer;
}

describe('UnopenableGapRow (#128 d)', () => {
    it('renders one small muted row saying how many messages could not be decrypted', () => {
        const renderer = render(7);
        const texts = renderer.root.findAllByType('Text' as never);
        expect(texts).toHaveLength(1);
        expect(texts[0].props.children).toBe('message.unopenableGap:{"count":7}');
        expect(texts[0].props.style).toMatchObject({ fontSize: 13, textAlign: 'center' });
        const rows = renderer.root.findAllByType('View' as never).filter((v) => v.props.testID === 'unopenable-gap-row');
        expect(rows).toHaveLength(1);
        expect(rows[0].props.style).toMatchObject({ alignItems: 'center' });
    });
});
