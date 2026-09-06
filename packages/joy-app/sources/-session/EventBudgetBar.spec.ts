// #130 — the relay's event budget, made visible from the card alone.
//
// The daemon publishes `joy__eventBudget` {since, dropped} on the session
// card once the relay refuses the session's output for good. This spec walks
// that field from the wire (MetadataSchema — the fixture that lost it) into
// the rendered bar, and asserts the bar owes nothing to a push notification:
// its only input is the session's decoded metadata, so a device with
// notifications disabled sees exactly the same warning.
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { theme, sessions, push } = vi.hoisted(() => {
    const proxy: unknown = new Proxy({}, {
        get: (_target, key) => (key === Symbol.toPrimitive || key === 'toJSON' ? () => '#000' : proxy),
    });
    return { theme: proxy, sessions: new Map<string, unknown>(), push: vi.fn() };
});

vi.mock('react-native', () => ({ View: 'View', Text: 'Text', Pressable: 'Pressable' }));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { hairlineWidth: 1, create: (styles: unknown) => (typeof styles === 'function' ? styles(theme) : styles) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/sync/storage', () => ({ useSession: (id: string) => sessions.get(id) ?? null }));
vi.mock('@/text', () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }));

import { MetadataSchema } from '@/sync/storageTypes';
import { EventBudgetBar } from './EventBudgetBar';

function render(sessionId: string) {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(React.createElement(EventBudgetBar, { sessionId }));
    });
    return renderer;
}

function seed(sessionId: string, card: Record<string, unknown>) {
    // The card as the sync layer decodes it — through the schema, not a cast,
    // so a schema that strips the field fails here rather than in production.
    sessions.set(sessionId, { id: sessionId, metadata: MetadataSchema.parse(card) });
}

describe('EventBudgetBar (#130)', () => {
    it('renders a persistent warning with the count, the time and the new-session action from the decoded card', () => {
        seed('s-full', { path: '/repo', host: 'machine', machineId: 'm1', joy__eventBudget: { since: 1_700_000_000_000, dropped: 5 } });
        const renderer = render('s-full');

        const bars = renderer.root.findAllByType('View' as never).filter((v) => v.props.testID === 'event-budget-bar');
        expect(bars).toHaveLength(1);
        expect(bars[0].props.accessibilityRole).toBe('alert');

        const texts = renderer.root.findAllByType('Text' as never).map((n) => n.props.children as string);
        expect(texts).toContain('joyEventBudget.label');
        expect(texts).toContain('joyEventBudget.title');
        const body = texts.find((s) => typeof s === 'string' && s.startsWith('joyEventBudget.body:'))!;
        expect(body).toBeDefined();
        const params = JSON.parse(body.slice('joyEventBudget.body:'.length)) as { dropped: number; since: string };
        expect(params.dropped).toBe(5);
        expect(params.since).toBe(new Date(1_700_000_000_000).toLocaleString());
        expect(texts).toContain('joyEventBudget.action');

        // The recovery: a fresh session on the same machine and folder.
        const action = renderer.root.findAllByType('Pressable' as never).find((p) => p.props.testID === 'event-budget-new-session')!;
        act(() => { (action.props.onPress as () => void)(); });
        expect(push).toHaveBeenCalledWith({ pathname: '/joy/new', params: { machineId: 'm1', path: '/repo' } });
    });

    it('renders nothing for a session whose card carries no loss', () => {
        seed('s-fine', { path: '/repo', host: 'machine', machineId: 'm1' });
        expect(render('s-fine').toJSON()).toBeNull();
        seed('s-zero', { path: '/repo', host: 'machine', joy__eventBudget: { since: 1, dropped: 0 } });
        expect(render('s-zero').toJSON()).toBeNull();
        seed('s-null', { path: '/repo', host: 'machine', joy__eventBudget: null });
        expect(render('s-null').toJSON()).toBeNull();
        expect(render('s-unknown').toJSON()).toBeNull();
    });
});
