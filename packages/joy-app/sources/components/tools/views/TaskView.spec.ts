import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { Message, ToolCall, ToolCallMessage } from '@/sync/typesMessage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A theme whose every leaf reads as a color string, so the real style sheets
// and icon colors resolve without the native theme runtime (hoisted: the
// mock factories below run before this module's own statements).
const { theme } = vi.hoisted(() => {
    const proxy: unknown = new Proxy({}, {
        get: (_target, key) => (key === Symbol.toPrimitive || key === 'toJSON' ? () => '#000' : proxy),
    });
    return { theme: proxy };
});

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Image: 'Image',
    ActivityIndicator: 'ActivityIndicator',
    Platform: { OS: 'web', select: (options: Record<string, unknown>) => options.default ?? options.web ?? options.ios },
    StyleSheet: { create: (styles: unknown) => styles },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: unknown) => (typeof styles === 'function' ? styles(theme) : styles) },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('@expo/vector-icons/Octicons', () => ({ default: 'Octicons' }));
vi.mock('@/text', () => ({ t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key) }));
vi.mock('@/components/CodeView', () => ({ CodeView: 'CodeView' }));
vi.mock('@/components/markdown/MarkdownView', () => ({ MarkdownView: 'MarkdownView' }));
// The real chat renderer for the child conversation — stubbed to a host node
// that keeps the message it was handed.
vi.mock('@/components/MessageView', () => ({ MessageView: 'MessageView' }));
vi.mock('../ToolFullView', () => ({ toolFullViewStyles: { section: {} } }));
vi.mock('../toolPresentation', () => ({ describeChildTool: (tool: ToolCall) => tool.name }));

import { TaskView, TaskViewFull } from './TaskView';

function call(name: string, input: unknown, result: unknown, state: ToolCall['state']): ToolCall {
    return { name, input, result, state, createdAt: 1, startedAt: 1, completedAt: state === 'running' ? null : 2, description: null };
}

function toolMessage(id: string, tool: ToolCall, children: Message[] = []): ToolCallMessage {
    return { kind: 'tool-call', id, localId: null, createdAt: 1, tool, children };
}

const children: Message[] = [
    toolMessage('r', call('Read', { file_path: '/a' }, 'contents', 'completed')),
    { kind: 'agent-text', id: 'think', localId: null, createdAt: 1, text: '*hmm*', isThinking: true },
    toolMessage('b', call('Bash', { command: 'pwd' }, undefined, 'running')),
    { kind: 'agent-text', id: 'a', localId: null, createdAt: 1, text: 'CHILD EXPLANATION' },
];

const mixedAnswer = [
    { type: 'text', text: 'RESULT TEXT' },
    { type: 'image', source: { type: 'base64', data: 'IMAGE_DATA', media_type: 'image/png' } },
];

function render(element: React.ReactElement) {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(element);
    });
    return renderer;
}

describe('TaskViewFull (#298)', () => {
    const task = call('Task', { prompt: 'Investigate' }, mixedAnswer, 'completed');

    it('renders the child conversation — agent text included — through the chat message renderer', () => {
        const renderer = render(React.createElement(TaskViewFull, { tool: task, metadata: null, messages: children, sessionId: 's1' }));
        const rows: ReactTestInstance[] = renderer.root.findAllByType('MessageView' as never);
        expect(rows.map((row) => (row.props.message as Message).id)).toEqual(['r', 'b', 'a']);
        expect(rows.every((row: ReactTestInstance) => row.props.sessionId === 's1')).toBe(true);
        const explanation = rows.find((row: ReactTestInstance) => (row.props.message as Message).id === 'a')!.props.message as Message;
        expect(explanation.kind === 'agent-text' && explanation.text).toBe('CHILD EXPLANATION');
        // Nested tool rows carry their children so nested controls / results render.
        const bash = rows.find((row: ReactTestInstance) => (row.props.message as Message).id === 'b')!.props.message as ToolCallMessage;
        expect(bash.tool.state).toBe('running');
    });

    it('renders every result block of a mixed text / image answer', () => {
        const renderer = render(React.createElement(TaskViewFull, { tool: task, metadata: null, messages: children, sessionId: 's1' }));
        const markdown = renderer.root.findAllByType('MarkdownView' as never).map((node: ReactTestInstance) => node.props.markdown as string);
        expect(markdown).toContain('Investigate');
        expect(markdown).toContain('RESULT TEXT');
        const images = renderer.root.findAllByType('Image' as never);
        expect(images).toHaveLength(1);
        expect((images[0].props.source as { uri: string }).uri).toBe('data:image/png;base64,IMAGE_DATA');
    });

    it('does not open the conversation section for thinking-only children', () => {
        const thinkingOnly: Message[] = [{ kind: 'agent-text', id: 'think', localId: null, createdAt: 1, text: '*hmm*', isThinking: true }];
        const renderer = render(React.createElement(TaskViewFull, { tool: task, metadata: null, messages: thinkingOnly }));
        expect(renderer.root.findAllByType('MessageView' as never)).toHaveLength(0);
        expect(JSON.stringify(renderer.toJSON())).not.toContain('tools.detail.subTools');
    });

    it('shows no answer for a failed Task (the full view reports the failure)', () => {
        const failed = call('Task', { prompt: 'Investigate' }, 'subagent crashed', 'error');
        const renderer = render(React.createElement(TaskViewFull, { tool: failed, metadata: null, messages: children, sessionId: 's1' }));
        const markdown = renderer.root.findAllByType('MarkdownView' as never).map((node: ReactTestInstance) => node.props.markdown as string);
        expect(markdown).toEqual(['Investigate']);
        expect(renderer.root.findAllByType('MessageView' as never)).toHaveLength(3);
    });
});

describe('TaskView compact preview', () => {
    it('keeps both of two sub-tool calls', () => {
        const renderer = render(React.createElement(TaskView, { tool: call('Task', { prompt: 'x' }, undefined, 'running'), metadata: null, messages: children }));
        const text = JSON.stringify(renderer.toJSON());
        expect(text).toContain('Read');
        expect(text).toContain('Bash');
        expect(text).not.toContain('moreTools');
    });
});
