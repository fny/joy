import { describe, it, expect } from 'vitest';
import { createReducer, reducer, ReducerState } from './reducer';
import { normalizeRawMessage, NormalizedMessage } from '../typesRaw';
import { AgentState } from '../storageTypes';
import { Message, ToolCallMessage } from '../typesMessage';
import * as fixtures from '../toolModel.fixtures';

/**
 * Identity-based projection: fixture-driven tests that feed captured provider
 * records through normalize → reducer and assert on the projected messages
 * and their canonical tool models.
 */

let counter = 0;
function norm(raw: unknown, seq: number | null = null, id?: string): NormalizedMessage {
    const messageId = id ?? `m-${++counter}`;
    const normalized = normalizeRawMessage(messageId, null, 1000 + (seq ?? counter), raw as any);
    if (!normalized) throw new Error(`fixture did not normalize: ${JSON.stringify(raw).slice(0, 120)}`);
    normalized.seq = seq;
    return normalized;
}

/** Project batches and return the final state of every emitted message by id. */
function project(batches: NormalizedMessage[][], agentState?: AgentState | null, state: ReducerState = createReducer('session-1')) {
    const byId = new Map<string, Message>();
    const deltas: Message[][] = [];
    for (const batch of batches) {
        const result = reducer(state, batch, agentState);
        deltas.push(result.messages);
        for (const message of result.messages) byId.set(message.id, message);
    }
    return { state, byId, deltas, messages: [...byId.values()] };
}

function toolMessages(messages: Message[]): ToolCallMessage[] {
    return messages.filter((m): m is ToolCallMessage => m.kind === 'tool-call');
}

type Snapshot = {
    name: string;
    seq: number | null | undefined;
    outcome: string;
    blocks: unknown[];
    errorMessage: string | null;
    callId: string | null;
    sessionId: string | null;
    children: Array<Snapshot | { kind: string; text: string | undefined }>;
};

/** Everything about a tool message that must be identical live vs replayed. */
function projection(message: ToolCallMessage): Snapshot {
    const model = message.tool.model!;
    return {
        name: message.tool.name,
        seq: message.seq,
        outcome: model.outcome,
        blocks: model.blocks,
        errorMessage: model.errorMessage,
        callId: model.identity.callId,
        sessionId: model.identity.sessionId,
        children: message.children.map((c) => (c.kind === 'tool-call' ? projection(c) : { kind: c.kind, text: (c as { text?: string }).text })),
    };
}

const claudeToolCall = (id: string, name: string, input: unknown, seq: number) =>
    norm(fixtures.claudeAssistantToolUse(id, name, input), seq, `msg-call-${id}`);
const claudeResult = (id: string, content: unknown, seq: number, isError = false) =>
    norm(fixtures.claudeUserToolResult(id, content, { isError }), seq, `msg-result-${id}`);

describe('identity-based projection', () => {
    it('projects the same conversation from a live stream and from replayed, reordered history', () => {
        const live = [
            claudeToolCall('t1', 'Read', { file_path: '/a' }, 1),
            norm(fixtures.claudeMultiBlockResult, 2, 'r1-msg'),
            claudeToolCall('t2', 'Edit', { file_path: '/b', old_string: 'x', new_string: 'y' }, 3),
            norm(fixtures.claudeToolUseError, 4, 'r2-msg'),
        ];
        // claudeMultiBlockResult answers toolu_read / claudeToolUseError answers toolu_edit
        live[0] = claudeToolCall('toolu_read', 'Read', { file_path: '/a' }, 1);
        live[2] = claudeToolCall('toolu_edit', 'Edit', { file_path: '/b', old_string: 'x', new_string: 'y' }, 3);

        const streamed = project(live.map((m) => [m]));
        const replayed = project([[...live].reverse()]);
        const oneBatch = project([live]);

        const snapshot = (p: ReturnType<typeof project>) =>
            toolMessages(p.messages).map(projection).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
        expect(snapshot(replayed)).toEqual(snapshot(streamed));
        expect(snapshot(oneBatch)).toEqual(snapshot(streamed));
        expect(snapshot(streamed).map((s) => s.outcome)).toEqual(['succeeded', 'failed']);
        expect(snapshot(streamed)[0].blocks).toEqual([{ kind: 'text', text: 'First file\nSecond file' }]);
        expect(snapshot(streamed)[1].errorMessage).toBe('File has not been read yet. Read it first before writing to it.');
        expect(snapshot(streamed)[0].sessionId).toBe('session-1');
        expect(snapshot(streamed)[0].callId).toBe('toolu_read');
    });

    it('retains a result that arrives before its call and applies it when the call lands (#392)', () => {
        const { state, messages } = project([
            [norm(fixtures.claudeToolUseError, 20, 'early-result')],
            [claudeToolCall('toolu_edit', 'Edit', { file_path: '/b', old_string: 'x', new_string: 'y' }, 10)],
        ]);
        const [edit] = toolMessages(messages);
        expect(edit.tool.state).toBe('error');
        expect(edit.tool.model?.outcome).toBe('failed');
        expect(state.pendingResults.size).toBe(0);
    });

    it('retains a sidechain result that arrives before its nested call', () => {
        const task = claudeToolCall('task-1', 'Task', { prompt: 'Look' }, 1);
        const nestedResult: NormalizedMessage = {
            id: 'nested-result', localId: null, createdAt: 3000, seq: 3, role: 'agent', isSidechain: true,
            content: [{ type: 'tool-result', tool_use_id: 'nested-read', content: 'contents', is_error: false, uuid: 'nr-uuid', parentUUID: 'task-1' }],
        };
        const nestedCall: NormalizedMessage = {
            id: 'nested-call', localId: null, createdAt: 2000, seq: 2, role: 'agent', isSidechain: true,
            content: [{ type: 'tool-call', id: 'nested-read', name: 'Read', input: { file_path: '/x' }, description: null, uuid: 'nc-uuid', parentUUID: 'task-1' }],
        };
        const { messages, state } = project([[task], [nestedResult], [nestedCall]]);
        const [taskMessage] = toolMessages(messages);
        expect(taskMessage.children).toHaveLength(1);
        const child = taskMessage.children[0];
        expect(child.kind === 'tool-call' && child.tool.state).toBe('completed');
        expect(child.kind === 'tool-call' && child.tool.model?.identity.parentCallId).toBe('task-1');
        expect(state.pendingResults.size).toBe(0);
    });

    it('keys subagent children by call id: parallel Task calls in one message keep their own output (#396)', () => {
        const twoTasks: NormalizedMessage = {
            id: 'both', localId: null, createdAt: 1000, seq: 1, role: 'agent', isSidechain: false,
            content: [
                { type: 'tool-call', id: 'tA', name: 'Task', input: { prompt: 'Prompt A' }, description: null, uuid: 'both-uuid', parentUUID: null },
                { type: 'tool-call', id: 'tB', name: 'Task', input: { prompt: 'Prompt B' }, description: null, uuid: 'both-uuid', parentUUID: null },
            ],
        };
        const rootA: NormalizedMessage = { id: 'rootA', localId: null, createdAt: 2000, seq: 2, role: 'agent', isSidechain: true, content: [{ type: 'sidechain', uuid: 'ra', prompt: 'Prompt A' }] };
        const rootB: NormalizedMessage = { id: 'rootB', localId: null, createdAt: 2001, seq: 3, role: 'agent', isSidechain: true, content: [{ type: 'sidechain', uuid: 'rb', prompt: 'Prompt B' }] };
        const answerA: NormalizedMessage = { id: 'ansA', localId: null, createdAt: 3000, seq: 4, role: 'agent', isSidechain: true, content: [{ type: 'text', text: 'Answer A', uuid: 'aa', parentUUID: 'ra' }] };
        const answerB: NormalizedMessage = { id: 'ansB', localId: null, createdAt: 3001, seq: 5, role: 'agent', isSidechain: true, content: [{ type: 'text', text: 'Answer B', uuid: 'ab', parentUUID: 'rb' }] };

        const { messages } = project([[twoTasks], [rootB, rootA], [answerA], [answerB]]);
        const tasks = toolMessages(messages);
        expect(tasks).toHaveLength(2);
        const byCall = new Map(tasks.map((t) => [t.tool.model!.identity.callId, t]));
        const textsOf = (t: ToolCallMessage | undefined) => t!.children.filter((c) => c.kind === 'agent-text').map((c) => (c as { text: string }).text);
        expect(textsOf(byCall.get('tA'))).toEqual(['Answer A']);
        expect(textsOf(byCall.get('tB'))).toEqual(['Answer B']);
    });

    it('links a sidechain that loaded before its Task (#388)', () => {
        const root: NormalizedMessage = { id: 'root', localId: null, createdAt: 2000, seq: 5, role: 'agent', isSidechain: true, content: [{ type: 'sidechain', uuid: '11111111-1111-4111-8111-111111111111', prompt: 'Find it' }] };
        const child: NormalizedMessage = { id: 'child', localId: null, createdAt: 2100, seq: 6, role: 'agent', isSidechain: true, content: [{ type: 'text', text: 'found', uuid: '22222222-2222-4222-8222-222222222222', parentUUID: '11111111-1111-4111-8111-111111111111' }] };
        const task = claudeToolCall('t-find', 'Task', { prompt: 'Find it' }, 1);
        const { messages, deltas } = project([[child, root], [task]]);
        expect(deltas[0]).toHaveLength(0);
        const [taskMessage] = toolMessages(messages);
        expect(taskMessage.children.map((c) => c.kind)).toEqual(['agent-text']);
    });

    it('merges duplicate live/history observations of one call idempotently', () => {
        const call = claudeToolCall('dup', 'Bash', { command: 'ls' }, 1);
        const callAgain = norm(fixtures.claudeAssistantToolUse('dup', 'Bash', { command: 'ls' }), 1, 'msg-call-dup-history');
        const result = claudeResult('dup', 'a\nb', 2);
        const resultAgain = norm(fixtures.claudeUserToolResult('dup', 'a\nb'), 2, 'msg-result-dup-history');
        const { messages, deltas } = project([[call], [result], [callAgain, resultAgain]]);
        expect(toolMessages(messages)).toHaveLength(1);
        expect(toolMessages(messages)[0].tool.model?.outcome).toBe('succeeded');
        // The replay changed nothing.
        expect(deltas[2]).toHaveLength(0);
    });

    it('a permission placeholder acquires the call\'s server seq and message id (#393)', () => {
        const agentState: AgentState = { requests: { 'perm-1': { tool: 'Bash', arguments: { command: 'rm x' }, createdAt: 500 } } };
        const state = createReducer('s');
        const first = reducer(state, [], agentState);
        expect(first.messages).toHaveLength(1);
        expect(first.messages[0].seq).toBeNull();
        const second = reducer(state, [claudeToolCall('perm-1', 'Bash', { command: 'rm x' }, 10)], agentState);
        expect(second.messages).toHaveLength(1);
        expect(second.messages[0].id).toBe(first.messages[0].id);
        expect(second.messages[0].seq).toBe(10);
        expect(state.messageIds.get('msg-call-perm-1')).toBe(first.messages[0].id);
        expect(second.messages[0].kind === 'tool-call' && second.messages[0].tool.model?.identity.messageId).toBe('msg-call-perm-1');
    });

    it('nested sidechain updates refresh the ROOT Task and never emit a child as a root (#394)', () => {
        const outer = claudeToolCall('outer', 'Task', { prompt: 'Outer' }, 1);
        const innerCall: NormalizedMessage = { id: 'inner-call', localId: null, createdAt: 2000, seq: 2, role: 'agent', isSidechain: true, content: [{ type: 'tool-call', id: 'inner', name: 'Task', input: { prompt: 'Inner' }, description: null, uuid: 'inner-uuid', parentUUID: 'outer' }] };
        const innerText: NormalizedMessage = { id: 'inner-text', localId: null, createdAt: 3000, seq: 3, role: 'agent', isSidechain: true, content: [{ type: 'text', text: 'deep answer', uuid: 'it-uuid', parentUUID: 'inner' }] };
        const { deltas, messages } = project([[outer], [innerCall], [innerText]]);
        expect(deltas[2]).toHaveLength(1);
        expect(deltas[2][0].kind === 'tool-call' && deltas[2][0].tool.name).toBe('Task');
        expect(deltas[2][0].kind === 'tool-call' && deltas[2][0].tool.model?.identity.callId).toBe('outer');
        const [root] = toolMessages(messages);
        expect(root.children).toHaveLength(1);
        const inner = root.children[0];
        expect(inner.kind === 'tool-call' && inner.children.map((c) => (c as { text?: string }).text)).toEqual(['deep answer']);
        expect(messages.filter((m) => m.kind === 'tool-call')).toHaveLength(1);
    });

    it('a completed subagent permission resolves the nested copy too (#395)', () => {
        const pending: AgentState = { requests: { 'nested-bash': { tool: 'Bash', arguments: { command: 'make' }, createdAt: 500 } } };
        const state = createReducer('s');
        reducer(state, [], pending);
        const task = claudeToolCall('task-p', 'Task', { prompt: 'Build' }, 1);
        const nestedCall: NormalizedMessage = { id: 'nb', localId: null, createdAt: 2000, seq: 2, role: 'agent', isSidechain: true, content: [{ type: 'tool-call', id: 'nested-bash', name: 'Bash', input: { command: 'make' }, description: null, uuid: 'nb-uuid', parentUUID: 'task-p' }] };
        reducer(state, [task, nestedCall], pending);
        const completed: AgentState = { completedRequests: { 'nested-bash': { tool: 'Bash', arguments: { command: 'make' }, createdAt: 500, completedAt: 600, status: 'approved' } } };
        const result = reducer(state, [], completed);
        const taskDelta = result.messages.find((m) => m.kind === 'tool-call' && m.tool.name === 'Task') as ToolCallMessage | undefined;
        expect(taskDelta).toBeDefined();
        const nested = taskDelta!.children.find((c) => c.kind === 'tool-call') as ToolCallMessage;
        expect(nested.tool.permission?.status).toBe('approved');
    });

    it('takes turn usage from a session-protocol ready event (#390)', () => {
        const ready: NormalizedMessage = { id: 'ready', localId: null, createdAt: 1000, seq: 9, role: 'event', isSidechain: false, content: { type: 'ready' }, usage: { input_tokens: 100, output_tokens: 20 } };
        const result = reducer(createReducer(), [ready]);
        expect(result.hasReadyEvent).toBe(true);
        expect(result.usage?.inputTokens).toBe(100);
        expect(result.usage?.outputTokens).toBe(20);
    });

    it('converts only the event block and keeps the sibling text and tool call (#387)', () => {
        const mixed: NormalizedMessage = {
            id: 'mixed', localId: null, createdAt: 1000, seq: 1, role: 'agent', isSidechain: false,
            content: [
                { type: 'text', text: 'Switching to planning.', uuid: 'mx', parentUUID: null },
                { type: 'tool-call', id: 'epm', name: 'EnterPlanMode', input: {}, description: null, uuid: 'mx', parentUUID: null },
                { type: 'tool-call', id: 'rd', name: 'Read', input: { file_path: '/plan.md' }, description: null, uuid: 'mx', parentUUID: null },
            ],
        };
        const result = reducer(createReducer(), [mixed]);
        expect(result.messages.map((m) => m.kind).sort()).toEqual(['agent-event', 'agent-text', 'tool-call']);
        expect(result.planModeTransition).toBe('enter');
    });

    it('reports plan-mode transitions only for fresh messages (#403)', () => {
        const state = createReducer();
        const exitAt100: NormalizedMessage = { id: 'exit', localId: null, createdAt: 5000, seq: 100, role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'x', name: 'ExitPlanMode', input: { plan: 'p' }, description: null, uuid: 'xu', parentUUID: null }] };
        const enterAt10: NormalizedMessage = { id: 'enter-old', localId: null, createdAt: 1000, seq: 10, role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'e', name: 'EnterPlanMode', input: {}, description: null, uuid: 'eu', parentUUID: null }] };
        const enterLive: NormalizedMessage = { id: 'enter-live', localId: null, createdAt: 9000, seq: null, role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: 'e2', name: 'EnterPlanMode', input: {}, description: null, uuid: 'eu2', parentUUID: null }] };
        expect(reducer(state, [exitAt100]).planModeTransition).toBe('exit');
        // Older page: historical state only, never the current mode.
        expect(reducer(state, [enterAt10]).planModeTransition).toBeUndefined();
        // Replaying an already-projected entry changes nothing either.
        expect(reducer(state, [enterAt10]).planModeTransition).toBeUndefined();
        expect(reducer(state, [enterLive]).planModeTransition).toBe('enter');
    });

    it('array-form user text riding with a tool result renders as the user\'s words (#411)', () => {
        const raw = {
            role: 'agent',
            content: { type: 'output', data: { type: 'user', uuid: 'u-mixed', parentUuid: null, message: { role: 'user', content: [
                { type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' },
                { type: 'text', text: 'Please fix the build' },
            ] } } },
        };
        const { messages } = project([[claudeToolCall('toolu_x', 'Bash', { command: 'make' }, 1)], [norm(raw, 2, 'mixed-user')]]);
        const user = messages.find((m) => m.kind === 'user-text');
        expect(user && user.kind === 'user-text' && user.text).toBe('Please fix the build');
        expect(toolMessages(messages)[0].tool.model?.outcome).toBe('succeeded');
    });

    it('every provider\'s error shape projects to a failed model', () => {
        const cases: Array<[NormalizedMessage, NormalizedMessage]> = [
            [claudeToolCall('toolu_edit', 'Edit', { file_path: '/b' }, 1), norm(fixtures.claudeToolUseError, 2)],
            [norm(fixtures.codexToolCall('cx', 'CodexBash', { command: 'make' }), 1), norm({ ...fixtures.codexStructuredResult, content: { ...fixtures.codexStructuredResult.content, data: { ...fixtures.codexStructuredResult.content.data, callId: 'cx', output: { stdout: '', stderr: 'boom', exitCode: 2 } } } }, 2)],
            [norm(fixtures.acpToolCall('gemini', 'g1', 'execute', fixtures.geminiExecuteInput), 1), norm(fixtures.acpErrorResult('gemini', 'g1', 'boom', true), 2)],
            [norm(fixtures.acpToolCall('opencode', 'o1', 'shell', { command: 'ls' }), 1), norm(fixtures.acpErrorResult('opencode', 'o1', 'boom', true), 2)],
            [norm(fixtures.sessionToolCallStart('p1', 'pi_tool', {}), 1), norm(fixtures.sessionToolCallEnd('p1', 'crashed', true), 2)],
        ];
        const outcomes = cases.map(([call, result]) => toolMessages(project([[call], [result]]).messages)[0].tool.model?.outcome);
        // Codex reports no error flag; its structured output is a success with stderr kept.
        expect(outcomes).toEqual(['failed', 'succeeded', 'failed', 'failed', 'failed']);
        const codex = toolMessages(project([[cases[1][0]], [cases[1][1]]]).messages)[0].tool.model;
        expect(codex?.command?.stderr).toBe('boom');
        expect(codex?.command?.exitCode).toBe(2);
    });

    it('zero, false and empty results survive projection as real output', () => {
        const zero = toolMessages(project([[norm(fixtures.sessionToolCallStart('z', 'pi_tool', {}), 1)], [norm(fixtures.sessionToolCallEnd('z', 0), 2)]]).messages)[0];
        expect(zero.tool.result).toBe(0);
        expect(zero.tool.model?.outcome).toBe('succeeded');
        expect(zero.tool.model?.outputText).toBe('0');
        const empty = toolMessages(project([[claudeToolCall('e', 'Bash', { command: 'true' }, 1)], [claudeResult('e', '', 2)]]).messages)[0];
        expect(empty.tool.model?.outcome).toBe('succeeded');
        expect(empty.tool.model?.blocks).toEqual([{ kind: 'text', text: '' }]);
    });

    it('projects a 5,000-message log incrementally — each batch costs the batch, not the log', () => {
        const state = createReducer('perf');
        const log: NormalizedMessage[] = [];
        let seq = 0;
        for (let i = 0; i < 1250; i++) {
            log.push({ id: `u-${i}`, localId: null, createdAt: ++seq, seq, role: 'user', isSidechain: false, content: { type: 'text', text: `prompt ${i}` } });
            log.push({ id: `a-${i}`, localId: null, createdAt: ++seq, seq, role: 'agent', isSidechain: false, content: [{ type: 'tool-call', id: `call-${i}`, name: 'Bash', input: { command: `echo ${i}` }, description: null, uuid: `au-${i}`, parentUUID: null }] });
            log.push({ id: `r-${i}`, localId: null, createdAt: ++seq, seq, role: 'agent', isSidechain: false, content: [{ type: 'tool-result', tool_use_id: `call-${i}`, content: `${i}`, is_error: false, uuid: `ru-${i}`, parentUUID: null }] });
            log.push({ id: `t-${i}`, localId: null, createdAt: ++seq, seq, role: 'agent', isSidechain: false, content: [{ type: 'text', text: `done ${i}`, uuid: `tu-${i}`, parentUUID: null }] });
        }
        expect(log).toHaveLength(5000);

        const batchSize = 100;
        const batchTimes: number[] = [];
        let emitted = 0;
        const started = performance.now();
        for (let i = 0; i < log.length; i += batchSize) {
            const t0 = performance.now();
            const result = reducer(state, log.slice(i, i + batchSize));
            batchTimes.push(performance.now() - t0);
            emitted += result.messages.length;
            // Incremental: a batch emits only the rows it touched (100 records → 75 rows:
            // the result merges into its call), never the whole projection.
            expect(result.messages.length).toBeLessThanOrEqual(batchSize);
        }
        const total = performance.now() - started;
        expect(emitted).toBe(3750);
        expect(state.messages.size).toBe(3750);
        // Per-batch cost stays flat: the last ten batches are not slower than
        // the first ten by more than noise (the log is 50x larger by then).
        const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        const head = avg(batchTimes.slice(0, 10));
        const tail = avg(batchTimes.slice(-10));
        expect(tail).toBeLessThan(Math.max(head * 4, 50));
        expect(total).toBeLessThan(5000);
    });
});
