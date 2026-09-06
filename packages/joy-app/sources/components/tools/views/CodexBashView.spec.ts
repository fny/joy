import { describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { ToolCall } from '@/sync/typesMessage';

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
vi.mock('@/components/CommandView', () => ({ CommandView: 'CommandView' }));
vi.mock('@/components/CodeView', () => ({ CodeView: 'CodeView' }));

import { CodexBashView } from './CodexBashView';

function call(input: unknown, result: unknown, state: ToolCall['state']): ToolCall {
    return { name: 'CodexBash', input, result, state, createdAt: 1, startedAt: 1, completedAt: state === 'running' ? null : 2, description: null };
}

const singleRead = { parsed_cmd: [{ type: 'read', name: 'a', cmd: 'cat a' }] };

function renderFull(tool: ToolCall) {
    let renderer!: ReactTestRenderer;
    act(() => {
        renderer = TestRenderer.create(React.createElement(CodexBashView, { tool, metadata: null, full: true }));
    });
    const commands = renderer.root.findAllByType('CommandView' as never);
    return { renderer, commands, text: JSON.stringify(renderer.toJSON()) };
}

describe('CodexBashView full details — single read / write branch (#285)', () => {
    it('renders a successful read whose only output is on stderr', () => {
        const { commands, text } = renderFull(call(singleRead, { stdout: '', stderr: 'WARNING ONLY' }, 'completed'));
        expect(commands).toHaveLength(1);
        expect(commands[0].props.command).toBe('cat a');
        expect(commands[0].props.stdout).toBe('');
        expect(commands[0].props.stderr).toBe('WARNING ONLY');
        expect(commands[0].props.error).toBeNull();
        expect(text).toContain('WARNING ONLY');
        expect(text).toContain('tools.desc.readingFile');
    });

    it('renders a failed read\'s partial stdout alongside its stderr', () => {
        const { commands } = renderFull(call(singleRead, { stdout: 'partial output', stderr: 'boom', exit_code: 1 }, 'error'));
        expect(commands).toHaveLength(1);
        expect(commands[0].props.stdout).toBe('partial output');
        expect(commands[0].props.stderr).toBe('boom');
        // The reason IS the stderr already shown — not printed twice.
        expect(commands[0].props.error).toBeNull();
    });

    it('renders a failed read\'s reason when it is not already on stderr', () => {
        const { commands } = renderFull(call(singleRead, { stdout: 'partial output', error: 'permission denied by sandbox' }, 'error'));
        expect(commands[0].props.stdout).toBe('partial output');
        expect(commands[0].props.stderr).toBeNull();
        expect(commands[0].props.error).toBe('permission denied by sandbox');
    });

    it('renders the output block even for an empty completed read', () => {
        const { commands } = renderFull(call(singleRead, { stdout: '', stderr: '' }, 'completed'));
        expect(commands).toHaveLength(1);
        expect(commands[0].props.stdout).toBe('');
    });

    it('keeps the stored streams in the general command branch', () => {
        const compound = { command: 'cat a && cat b', parsed_cmd: [{ type: 'read', name: 'a', cmd: 'cat a' }, { type: 'read', name: 'b', cmd: 'cat b' }] };
        const { commands } = renderFull(call(compound, { stdout: '', stderr: 'WARNING ONLY' }, 'completed'));
        expect(commands[0].props.command).toBe('cat a && cat b');
        expect(commands[0].props.stderr).toBe('WARNING ONLY');
    });
});
