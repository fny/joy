import { describe, expect, it, vi } from 'vitest';
import { ToolCall } from '@/sync/typesMessage';

vi.mock('@/text', () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key}:${JSON.stringify(params)}` : key),
}));

import {
    getTerminalToolCommand,
    getToolSummaryCategory,
    getToolSummaryDetail,
    getToolSummaryTitle,
    isTerminalToolName,
    shouldRenderToolCardHeader,
} from './toolDisplay';

function tool(name: string, input: unknown): ToolCall {
    return {
        name,
        state: 'completed',
        input,
        createdAt: 1,
        startedAt: 1,
        completedAt: 2,
        description: null,
    };
}

describe('terminal tool display helpers', () => {
    it('detects command-like terminal tools', () => {
        expect(isTerminalToolName('Bash')).toBe(true);
        expect(isTerminalToolName('CodexBash')).toBe(true);
        expect(isTerminalToolName('GeminiBash')).toBe(true);
        expect(isTerminalToolName('execute')).toBe(true);
        expect(isTerminalToolName('Read')).toBe(false);
    });

    it('extracts one-line command summaries from shell tools', () => {
        expect(getTerminalToolCommand(tool('Bash', { command: 'pnpm test' }))).toBe('pnpm test');

        expect(getTerminalToolCommand(tool(
            'CodexBash',
            {
                command: ['/usr/bin/zsh', '-lc', 'git status --short'],
                parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
            },
        ))).toBe('git status --short');
    });

    it('extracts Gemini execute titles without cwd metadata', () => {
        expect(getTerminalToolCommand(tool(
            'execute',
            { toolCall: { title: 'rm tmp.txt [current working directory /repo] (cleanup)' } },
        ))).toBe('rm tmp.txt');
    });

    it('hides Codex patch card headers on web only', () => {
        expect(shouldRenderToolCardHeader('CodexPatch', 'web')).toBe(false);
        expect(shouldRenderToolCardHeader('CodexPatch', 'ios')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexPatch', 'android')).toBe(true);
        expect(shouldRenderToolCardHeader('CodexBash', 'web')).toBe(true);
    });

    it('classifies tools for compact transcript rows', () => {
        expect(getToolSummaryCategory('CodexBash')).toBe('terminal');
        expect(getToolSummaryCategory('CodexPatch')).toBe('edit');
        expect(getToolSummaryCategory('Read')).toBe('read');
        expect(getToolSummaryCategory('Grep')).toBe('search');
        expect(getToolSummaryCategory('WebFetch')).toBe('web');
    });

    it('extracts compact transcript row details', () => {
        expect(getToolSummaryDetail(tool('CodexBash', {
            command: ['/usr/bin/zsh', '-lc', 'git status --short'],
            parsed_cmd: [{ type: 'bash', cmd: 'git status --short' }],
        }))).toBe('git status --short');

        expect(getToolSummaryDetail(tool('CodexPatch', {
            changes: {
                'README-RU.md': { kind: { type: 'update' } },
            },
        }))).toBe('README-RU.md');

        expect(getToolSummaryDetail(tool('MultiEdit', {
            file_path: '/repo/src/app.tsx',
        }))).toBe('/repo/src/app.tsx');
    });

    it('shows a compound Codex command whole — the canonical model\'s command, not the first parsed_cmd (#286)', () => {
        const compound = tool('CodexBash', {
            command: 'cat a && cat b',
            parsed_cmd: [
                { type: 'read', name: 'a', cmd: 'cat a' },
                { type: 'read', name: 'b', cmd: 'cat b' },
            ],
        });
        expect(getTerminalToolCommand(compound)).toBe('cat a && cat b');
        expect(getToolSummaryDetail(compound)).toBe('cat a && cat b');
    });

    it('keeps the shell brackets of a Gemini execute title (#295)', () => {
        const gemini = tool('execute', {
            toolCall: { title: 'if [ -f x ]; then cat x; fi [current working directory /repo] (read x)' },
        });
        expect(getTerminalToolCommand(gemini)).toBe('if [ -f x ]; then cat x; fi');
        expect(getToolSummaryDetail(gemini)).toBe('if [ -f x ]; then cat x; fi');
    });

    it('every live preview is the same bounded one-line projection, running or settled', () => {
        const heredoc = "cat <<'EOF' > f\nbody\nEOF";
        const running: ToolCall = { ...tool('Bash', { command: heredoc }), state: 'running', completedAt: null };
        expect(getTerminalToolCommand(running)).toBe("cat <<'EOF' > f …");
        expect(getTerminalToolCommand(tool('Bash', { command: heredoc }))).toBe("cat <<'EOF' > f …");
        expect(getToolSummaryDetail(running)).toBe("cat <<'EOF' > f …");

        expect(getTerminalToolCommand(tool('Bash', { command: 'a && \\\n  b | c' }))).toBe('a && b | c');
        expect(getTerminalToolCommand(tool('run_shell_command', { command: 'npm test', directory: '/repo' }))).toBe('npm test');
        expect(getToolSummaryCategory('run_shell_command')).toBe('terminal');
        expect(getTerminalToolCommand(tool('Bash', { command: `echo ${'x'.repeat(500)}` }))!.length).toBeLessThanOrEqual(200);
    });

    it('survives malformed arguments in the summary detail', () => {
        expect(getToolSummaryDetail(tool('Read', null))).toBeNull();
        expect(getToolSummaryDetail(tool('CodexBash', { command: 'ls', parsed_cmd: [null] }))).toBe('ls');
    });
});

describe('compact transcript row titles (#318)', () => {
    function edit(state: ToolCall['state'], result?: unknown): ToolCall {
        return { ...tool('Edit', { file_path: '/a', old_string: 'x', new_string: 'y' }), state, result, completedAt: state === 'running' ? null : 2 };
    }

    it('only a succeeded edit is "Edited file"', () => {
        expect(getToolSummaryTitle('edit', edit('completed'))).toBe('toolGroup.editedFile');
    });

    it('a running edit says it is pending, not edited', () => {
        expect(getToolSummaryTitle('edit', edit('running'))).toBe('tools.names.editFile · tools.outcome.pending');
    });

    it('a failed or denied edit names that outcome', () => {
        expect(getToolSummaryTitle('edit', edit('error', 'No matching text found'))).toBe('tools.names.editFile · tools.outcome.failed');
        const denied: ToolCall = { ...edit('error'), permission: { id: 'p', status: 'denied' } };
        expect(getToolSummaryTitle('edit', denied)).toBe('tools.names.editFile · tools.outcome.denied');
    });

    it('other categories keep their neutral names', () => {
        expect(getToolSummaryTitle('read', tool('Read', { file_path: '/a' }))).toBe('tools.names.readFile');
        expect(getToolSummaryTitle('other', tool('Weird', {}))).toBe('Weird');
    });
});
