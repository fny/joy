/**
 * #128 — the session screen mounts the chat (and drops the empty-state
 * placeholder) when the session has rows this device could not decrypt,
 * even with ZERO stored messages: an initial page that was entirely
 * unreadable used to render EmptyMessages, so the "could not decrypt N
 * messages" warning never appeared for exactly the case it exists for.
 *
 * SessionView.tsx's module graph (expo-router, unistyles, native modules)
 * cannot load under vitest, so the gate is lifted out of the REAL source
 * with the TypeScript AST — the `hasChatRows` rule, the ChatList branch and
 * the `placeholder` branch — transpiled, and rendered with
 * react-test-renderer against a ChatList stand-in that projects the gap
 * rows the way the real one does (sync/unopenableGapRows) and renders the
 * real UnopenableGapRow for each.
 */
import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import ts from 'typescript';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

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

import { UnopenableGapRow } from '@/components/UnopenableGapRow';
import { projectUnopenableGapRows } from '@/sync/unopenableGapRows';
import type { Message, UnopenableGapRange } from '@/sync/typesMessage';

const VIEW_FILE = fileURLToPath(new URL('./SessionView.tsx', import.meta.url));

type GateProps = {
    messages: Message[];
    unopenableGaps: UnopenableGapRange[];
    isLoaded: boolean;
};

/** The three pieces of the gate, as they are committed, joined into one
 *  render function: `(messages, unopenableGaps, isLoaded) → <chat, placeholder>`. */
function liftGate(): (props: GateProps) => React.ReactNode {
    const src = fs.readFileSync(VIEW_FILE, 'utf8');
    const sf = ts.createSourceFile('SessionView.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let rule: string | undefined;
    let chatBranch: string | undefined;
    let placeholderBranch: string | undefined;
    const visit = (n: ts.Node) => {
        if (ts.isVariableDeclaration(n) && n.initializer) {
            const name = n.name.getText(sf);
            if (name === 'hasChatRows') rule = n.initializer.getText(sf);
            if (name === 'placeholder' && n.initializer.getText(sf).includes('<EmptyMessages ')) placeholderBranch = n.initializer.getText(sf);
        }
        if (ts.isJsxExpression(n) && n.expression && n.expression.getText(sf).includes('<ChatList ')) chatBranch = n.expression.getText(sf);
        ts.forEachChild(n, visit);
    };
    visit(sf);
    if (!rule || !chatBranch || !placeholderBranch) throw new Error('SessionView.tsx: chat gate not found');
    const code = [
        `const hasChatRows = ${rule};`,
        `const chat = ${chatBranch};`,
        `const placeholder = ${placeholderBranch};`,
        'return React.createElement(React.Fragment, null, chat, placeholder);',
    ].join('\n');
    const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }, fileName: 'gate.tsx' }).outputText;
    const params = ['React', 'messages', 'unopenableGaps', 'isLoaded', 'session', 'chatListRef', 'theme', 'ChatList', 'EmptyMessages', 'ActivityIndicator'];
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function(...params, js) as (...args: unknown[]) => React.ReactNode;
    return ({ messages, unopenableGaps, isLoaded }) => {
        // What the real ChatList does with the store: project a placeholder
        // row per gap into the stored history, then render the rows.
        const ChatList = React.forwardRef<unknown, { session: unknown }>(function ChatListStub(_props, _ref) {
            const rows = projectUnopenableGapRows(messages, unopenableGaps);
            return React.createElement(
                'ChatList',
                null,
                ...rows.map((row) => row.kind === 'unopenable-gap'
                    ? React.createElement(UnopenableGapRow, { key: row.id, count: row.count })
                    : React.createElement('Message', { key: row.id })),
            );
        });
        return run(React, messages, unopenableGaps, isLoaded, { id: 'S' }, { current: null }, theme, ChatList, 'EmptyMessages', 'ActivityIndicator');
    };
}

function render(props: GateProps) {
    const Gate = liftGate();
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(React.createElement(Gate, props));
    });
    return renderer;
}

const byType = (renderer: ReactTestRenderer, type: string) => renderer.root.findAllByType(type as never);

describe('SessionView mounts the chat for undecryptable history (#128)', () => {
    it('zero stored messages + one gap: the chat mounts with the gap placeholder, not the empty state', () => {
        const renderer = render({ messages: [], unopenableGaps: [{ fromSeq: 0, toSeq: 2, count: 2 }], isLoaded: true });
        expect(byType(renderer, 'ChatList')).toHaveLength(1);
        const rows = byType(renderer, 'View').filter((v) => v.props.testID === 'unopenable-gap-row');
        expect(rows).toHaveLength(1);
        expect(byType(renderer, 'Text')[0].props.children).toBe('message.unopenableGap:{"count":2}');
        expect(byType(renderer, 'EmptyMessages')).toHaveLength(0);
        expect(byType(renderer, 'ActivityIndicator')).toHaveLength(0);
    });

    it('zero stored messages and no gap: the empty state, as before', () => {
        const renderer = render({ messages: [], unopenableGaps: [], isLoaded: true });
        expect(byType(renderer, 'ChatList')).toHaveLength(0);
        expect(byType(renderer, 'EmptyMessages')).toHaveLength(1);
    });

    it('nothing loaded yet and no gap: the spinner, as before', () => {
        const renderer = render({ messages: [], unopenableGaps: [], isLoaded: false });
        expect(byType(renderer, 'ChatList')).toHaveLength(0);
        expect(byType(renderer, 'ActivityIndicator')).toHaveLength(1);
        expect(byType(renderer, 'EmptyMessages')).toHaveLength(0);
    });

    it('stored messages with no gap: the chat, no placeholder row', () => {
        const message = { kind: 'user-text', id: 'm1', seq: 1, createdAt: 1 } as unknown as Message;
        const renderer = render({ messages: [message], unopenableGaps: [], isLoaded: true });
        expect(byType(renderer, 'ChatList')).toHaveLength(1);
        expect(byType(renderer, 'Message')).toHaveLength(1);
        expect(byType(renderer, 'View').filter((v) => v.props.testID === 'unopenable-gap-row')).toHaveLength(0);
        expect(byType(renderer, 'EmptyMessages')).toHaveLength(0);
    });
});
