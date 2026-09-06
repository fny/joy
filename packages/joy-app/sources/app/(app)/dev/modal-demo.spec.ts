/**
 * The modal demo's "Multiple Modals" item shows a second alert 1.5s after the
 * first. That delayed alert belongs to the screen: leaving the demo before it
 * fires must not open "Second Modal" over the destination screen (#143), and
 * re-running the sequence must not stack a second pending alert.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { alert } = vi.hoisted(() => ({ alert: vi.fn() }));

vi.mock('react-native', () => ({
    View: 'View', Text: 'Text', ScrollView: 'ScrollView',
    Platform: { OS: 'web' },
    StyleSheet: { create: (x: unknown) => x, hairlineWidth: 1 },
}));
vi.mock('@/modal', () => ({ Modal: { alert, confirm: vi.fn(async () => true), show: vi.fn() } }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
// The list chrome is not under test; a bare stub keeps the item's title and
// onPress reachable without pulling unistyles into the node environment.
vi.mock('@/components/Item', () => ({ Item: (props: Record<string, unknown>) => React.createElement('item-stub', props) }));
vi.mock('@/components/ItemGroup', () => ({ ItemGroup: (props: { children?: React.ReactNode }) => React.createElement('group-stub', null, props.children) }));
vi.mock('@/components/ItemList', () => ({ ItemList: (props: { children?: React.ReactNode }) => React.createElement('list-stub', null, props.children) }));
vi.mock('@/components/RoundButton', () => ({ RoundButton: () => null }));

import ModalDemoScreen from './modal-demo';

type ItemStub = { props: { title: string; onPress: () => void } };

let renderer: ReactTestRenderer | null = null;

async function mount() {
    await act(async () => { renderer = create(React.createElement(ModalDemoScreen)); });
}
function item(title: string): ItemStub {
    const found = (renderer!.root.findAllByType('item-stub' as never) as unknown as ItemStub[]).find((i) => i.props.title === title);
    if (!found) throw new Error(`no item titled ${title}`);
    return found;
}
const press = (title: string) => act(async () => { item(title).props.onPress(); });
const titles = () => alert.mock.calls.map((c) => c[0] as string);

describe('modal demo — the delayed second alert dies with the screen (#143)', () => {
    beforeEach(() => { vi.useFakeTimers(); alert.mockClear(); });
    afterEach(async () => {
        if (renderer) await act(async () => { renderer!.unmount(); });
        renderer = null;
        vi.useRealTimers();
    });

    it('leaving the screen before 1.5s cancels the second alert', async () => {
        await mount();
        await press('Multiple Modals');
        expect(titles()).toEqual(['First Modal']);

        await act(async () => { renderer!.unmount(); });
        renderer = null;
        await act(async () => { vi.advanceTimersByTime(5000); });

        expect(titles()).toEqual(['First Modal']);
    });

    it('while the screen stays mounted the second alert follows after 1.5s', async () => {
        await mount();
        await press('Multiple Modals');
        await act(async () => { vi.advanceTimersByTime(1499); });
        expect(titles()).toEqual(['First Modal']);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(titles()).toEqual(['First Modal', 'Second Modal']);
    });

    it('re-running the sequence drops the earlier pending second alert instead of stacking it', async () => {
        await mount();
        await press('Multiple Modals');
        await act(async () => { vi.advanceTimersByTime(1000); });
        await press('Multiple Modals');
        await act(async () => { vi.advanceTimersByTime(1000); });
        // The first run's 1.5s mark has passed; only the second run's timer lives.
        expect(titles()).toEqual(['First Modal', 'First Modal']);
        await act(async () => { vi.advanceTimersByTime(500); });
        expect(titles()).toEqual(['First Modal', 'First Modal', 'Second Modal']);
    });
});
