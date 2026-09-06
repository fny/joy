import { describe, it, expect } from 'vitest';
import { createTracer, traceMessages } from './reducerTracer';
import { NormalizedMessage } from '../typesRaw';

describe('reducerTracer', () => {
    describe('createTracer', () => {
        it('should create initial state', () => {
            const state = createTracer();
            expect(state.taskTools.size).toBe(0);
            expect(state.promptToTaskIds.size).toBe(0);
            expect(state.uuidToSidechainId.size).toBe(0);
            expect(state.parentIdToCallId.size).toBe(0);
            expect(state.orphanMessages.size).toBe(0);
            expect(state.pendingRoots.size).toBe(0);
            expect(state.processedIds.size).toBe(0);
        });
    });

    describe('traceMessages', () => {
        it('should return non-sidechain messages immediately', () => {
            const state = createTracer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: null,
                    createdAt: 1000,
                    role: 'user',
                    isSidechain: false,
                    content: { type: 'text', text: 'Hello' }
                },
                {
                    id: 'msg2',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{ type: 'text', text: 'Hi there', uuid: 'uuid1', parentUUID: null }]
                }
            ];

            const traced = traceMessages(state, messages);
            
            expect(traced).toHaveLength(2);
            expect(traced[0].sidechainId).toBeUndefined();
            expect(traced[1].sidechainId).toBeUndefined();
            expect(state.processedIds.size).toBe(2);
        });

        it('should identify and track Task tools', () => {
            const state = createTracer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool1',
                        name: 'Task',
                        input: { prompt: 'Search for files' },
                        description: null,
                        uuid: 'uuid1',
                        parentUUID: null
                    }]
                }
            ];

            traceMessages(state, messages);
            
            expect(state.taskTools.size).toBe(1);
            // Keyed by the CALL id — one message may hold several Task calls.
            expect(state.taskTools.get('tool1')).toEqual({
                callId: 'tool1',
                messageId: 'msg1',
                prompt: 'Search for files'
            });
            expect(state.promptToTaskIds.get('Search for files')).toEqual(['tool1']);
        });

        it('should identify and track Agent tools', () => {
            const state = createTracer();
            const messages: NormalizedMessage[] = [
                {
                    id: 'msg-agent',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'agent-tool',
                        name: 'Agent',
                        input: { prompt: 'Inspect translations' },
                        description: null,
                        uuid: 'uuid-agent',
                        parentUUID: null
                    }]
                }
            ];

            traceMessages(state, messages);

            expect(state.taskTools.get('agent-tool')).toEqual({
                callId: 'agent-tool',
                messageId: 'msg-agent',
                prompt: 'Inspect translations'
            });
            expect(state.promptToTaskIds.get('Inspect translations')).toEqual(['agent-tool']);
        });

        it('should assign sidechainId to sidechain root messages', () => {
            const state = createTracer();
            
            // First, process a Task tool
            const taskMessage: NormalizedMessage = {
                id: 'task1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'Task',
                    input: { prompt: 'Search for files' },
                    description: null,
                    uuid: 'task-uuid',
                    parentUUID: null
                }]
            };
            
            traceMessages(state, [taskMessage]);
            
            // Then process the sidechain root
            const sidechainRoot: NormalizedMessage = {
                id: 'sidechain1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: 'sidechain-uuid',
                    prompt: 'Search for files'
                }]
            };
            
            const traced = traceMessages(state, [sidechainRoot]);
            
            expect(traced).toHaveLength(1);
            expect(traced[0].sidechainId).toBe('tool1');
            expect(state.uuidToSidechainId.get('sidechain-uuid')).toBe('tool1');
        });

        it('should handle sidechain messages with parent relationships', () => {
            const state = createTracer();
            
            // Setup: Task and sidechain root
            const setup: NormalizedMessage[] = [
                {
                    id: 'task1',
                    localId: null,
                    createdAt: 1000,
                    role: 'agent',
                    isSidechain: false,
                    content: [{
                        type: 'tool-call',
                        id: 'tool1',
                        name: 'Task',
                        input: { prompt: 'Search for files' },
                        description: null,
                        uuid: 'task-uuid',
                        parentUUID: null
                    }]
                },
                {
                    id: 'sidechain1',
                    localId: null,
                    createdAt: 2000,
                    role: 'agent',
                    isSidechain: true,
                    content: [{
                        type: 'sidechain',
                        uuid: 'sidechain-uuid',
                        prompt: 'Search for files'
                    }]
                }
            ];
            
            traceMessages(state, setup);
            
            // Process child of sidechain
            const sidechainChild: NormalizedMessage = {
                id: 'child1',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'Searching...',
                    uuid: 'child-uuid',
                    parentUUID: 'sidechain-uuid'
                }]
            };
            
            const traced = traceMessages(state, [sidechainChild]);
            
            expect(traced).toHaveLength(1);
            expect(traced[0].sidechainId).toBe('tool1');
            expect(state.uuidToSidechainId.get('child-uuid')).toBe('tool1');
        });

        it('should link subagent-based sidechain messages to parent tool call message', () => {
            const state = createTracer();

            const parentToolMessage: NormalizedMessage = {
                id: 'parent-msg',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-call-1',
                    name: 'Task',
                    input: { prompt: 'Inspect auth code' },
                    description: null,
                    uuid: 'parent-uuid',
                    parentUUID: null
                }]
            };

            traceMessages(state, [parentToolMessage]);

            const subagentMessage: NormalizedMessage = {
                id: 'child-msg',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'subagent output',
                    uuid: 'child-uuid',
                    parentUUID: 'tool-call-1'
                }]
            };

            const traced = traceMessages(state, [subagentMessage]);
            expect(traced).toHaveLength(1);
            expect(traced[0].sidechainId).toBe('tool-call-1');
        });

        it('should link session subagent ids from tool input to the parent tool call message', () => {
            const state = createTracer();

            const parentToolMessage: NormalizedMessage = {
                id: 'parent-agent-msg',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-agent-1',
                    name: 'Agent',
                    input: {
                        prompt: 'Inspect translations',
                        sessionSubagent: 'session-subagent-1',
                    },
                    description: null,
                    uuid: 'parent-agent-uuid',
                    parentUUID: null
                }]
            };

            traceMessages(state, [parentToolMessage]);

            const subagentMessage: NormalizedMessage = {
                id: 'child-agent-msg',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'subagent output',
                    uuid: 'child-agent-uuid',
                    parentUUID: 'session-subagent-1'
                }]
            };

            const traced = traceMessages(state, [subagentMessage]);
            expect(traced).toHaveLength(1);
            expect(traced[0].sidechainId).toBe('tool-agent-1');
        });

        it('should buffer orphan messages until parent arrives', () => {
            const state = createTracer();
            
            // Setup: Task
            const task: NormalizedMessage = {
                id: 'task1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'Task',
                    input: { prompt: 'Search for files' },
                    description: null,
                    uuid: 'task-uuid',
                    parentUUID: null
                }]
            };
            
            traceMessages(state, [task]);
            
            // Process orphan (parent not yet seen)
            const orphan: NormalizedMessage = {
                id: 'orphan1',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'Orphan message',
                    uuid: 'orphan-uuid',
                    parentUUID: '11111111-1111-4111-8111-111111111111'
                }]
            };
            
            let traced = traceMessages(state, [orphan]);
            
            // Orphan should be buffered, not returned
            expect(traced).toHaveLength(0);
            expect(state.orphanMessages.has('11111111-1111-4111-8111-111111111111')).toBe(true);
            
            // Process parent
            const parent: NormalizedMessage = {
                id: 'sidechain1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: '11111111-1111-4111-8111-111111111111',
                    prompt: 'Search for files'
                }]
            };
            
            traced = traceMessages(state, [parent]);
            
            // Should return both parent and orphan
            expect(traced).toHaveLength(2);
            expect(traced[0].id).toBe('sidechain1');
            expect(traced[0].sidechainId).toBe('tool1');
            expect(traced[1].id).toBe('orphan1');
            expect(traced[1].sidechainId).toBe('tool1');
            
            // Orphan buffer should be cleared
            expect(state.orphanMessages.has('11111111-1111-4111-8111-111111111111')).toBe(false);
        });

        it('should handle recursive orphan processing', () => {
            const state = createTracer();
            
            // Setup: Task
            const task: NormalizedMessage = {
                id: 'task1',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool1',
                    name: 'Task',
                    input: { prompt: 'Search for files' },
                    description: null,
                    uuid: 'task-uuid',
                    parentUUID: null
                }]
            };
            
            traceMessages(state, [task]);
            
            // Process multiple orphans in reverse order
            const orphan2: NormalizedMessage = {
                id: 'orphan2',
                localId: null,
                createdAt: 4000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'Second orphan',
                    uuid: '33333333-3333-4333-8333-333333333333',
                    parentUUID: '22222222-2222-4222-8222-222222222222'
                }]
            };
            
            const orphan1: NormalizedMessage = {
                id: 'orphan1',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'First orphan',
                    uuid: '22222222-2222-4222-8222-222222222222',
                    parentUUID: '11111111-1111-4111-8111-111111111111'
                }]
            };
            
            // Process orphans out of order
            traceMessages(state, [orphan2, orphan1]);
            
            // Both should be buffered
            expect(state.orphanMessages.has('22222222-2222-4222-8222-222222222222')).toBe(true);
            expect(state.orphanMessages.has('11111111-1111-4111-8111-111111111111')).toBe(true);
            
            // Process root
            const root: NormalizedMessage = {
                id: 'sidechain1',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'sidechain',
                    uuid: '11111111-1111-4111-8111-111111111111',
                    prompt: 'Search for files'
                }]
            };
            
            const traced = traceMessages(state, [root]);
            
            // Should return all three in correct order
            expect(traced).toHaveLength(3);
            expect(traced[0].id).toBe('sidechain1');
            expect(traced[1].id).toBe('orphan1');
            expect(traced[2].id).toBe('orphan2');
            
            // All should have the same sidechainId
            expect(traced[0].sidechainId).toBe('tool1');
            expect(traced[1].sidechainId).toBe('tool1');
            expect(traced[2].sidechainId).toBe('tool1');
            
            // Orphan buffers should be cleared
            expect(state.orphanMessages.size).toBe(0);
        });

        it('buffers a subagent child until its parent tool call arrives, then links it (#388)', () => {
            const state = createTracer();

            const orphanSubagent: NormalizedMessage = {
                id: 'subagent-child',
                localId: null,
                createdAt: 1500,
                role: 'agent',
                isSidechain: true,
                content: [{
                    type: 'text',
                    text: 'waiting for parent tool',
                    uuid: 'subagent-child-uuid',
                    parentUUID: 'tool-call-late'
                }]
            };

            // Not emitted as a root, not marked processed — it waits.
            const firstPass = traceMessages(state, [orphanSubagent]);
            expect(firstPass).toHaveLength(0);
            expect(state.orphanMessages.has('tool-call-late')).toBe(true);
            expect(state.processedIds.has('subagent-child')).toBe(false);

            const lateParent: NormalizedMessage = {
                id: 'late-parent-msg',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{
                    type: 'tool-call',
                    id: 'tool-call-late',
                    name: 'Task',
                    input: { prompt: 'late' },
                    description: null,
                    uuid: 'late-parent-uuid',
                    parentUUID: null
                }]
            };
            const secondPass = traceMessages(state, [lateParent]);
            expect(secondPass.map((m) => m.id)).toEqual(['subagent-child', 'late-parent-msg']);
            expect(secondPass[0].sidechainId).toBe('tool-call-late');
            expect(state.orphanMessages.has('tool-call-late')).toBe(false);
        });

        it('links a sidechain root that loaded before its Task (#388)', () => {
            const state = createTracer();
            const root: NormalizedMessage = {
                id: 'early-root',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'sidechain', uuid: '11111111-1111-4111-8111-111111111111', prompt: 'Find it' }]
            };
            const child: NormalizedMessage = {
                id: 'early-child',
                localId: null,
                createdAt: 2100,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'text', text: 'found', uuid: '22222222-2222-4222-8222-222222222222', parentUUID: '11111111-1111-4111-8111-111111111111' }]
            };
            expect(traceMessages(state, [child, root])).toHaveLength(0);
            expect(state.pendingRoots.get('Find it')).toHaveLength(1);
            expect(state.processedIds.has('early-root')).toBe(false);

            const task: NormalizedMessage = {
                id: 'task-msg',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'tool-call', id: 'tool-find', name: 'Task', input: { prompt: 'Find it' }, description: null, uuid: 'task-uuid', parentUUID: null }]
            };
            const released = traceMessages(state, [task]);
            expect(released.map((m) => m.id)).toEqual(['early-root', 'early-child', 'task-msg']);
            expect(released[0].sidechainId).toBe('tool-find');
            expect(released[1].sidechainId).toBe('tool-find');
            expect(state.pendingRoots.size).toBe(0);
        });

        it('buffers a root delivered twice only once, so it claims a single Task (#388)', () => {
            const state = createTracer();
            const root: NormalizedMessage = {
                id: 'root',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'sidechain', uuid: 'root-uuid', prompt: 'Same' }]
            };
            expect(traceMessages(state, [root])).toHaveLength(0);
            expect(traceMessages(state, [root])).toHaveLength(0);
            expect(state.pendingRoots.get('Same')).toHaveLength(1);
            expect(state.bufferedIds.has('root')).toBe(true);

            const tasks: NormalizedMessage = {
                id: 'tasks',
                localId: null,
                createdAt: 2000,
                role: 'agent',
                isSidechain: false,
                content: [
                    { type: 'tool-call', id: 'a', name: 'Task', input: { prompt: 'Same' }, description: null, uuid: 'tasks-uuid', parentUUID: null },
                    { type: 'tool-call', id: 'b', name: 'Task', input: { prompt: 'Same' }, description: null, uuid: 'tasks-uuid', parentUUID: null },
                ]
            };
            const released = traceMessages(state, [tasks]);
            expect(released.filter((m) => m.id === 'root')).toHaveLength(1);
            expect(state.uuidToSidechainId.get('root-uuid')).toBe('a');
            expect(state.promptToTaskIds.get('Same')).toEqual(['b']);
            expect(state.bufferedIds.has('root')).toBe(false);

            const child: NormalizedMessage = {
                id: 'child',
                localId: null,
                createdAt: 3000,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'text', text: 'belongs to a', uuid: 'child-uuid', parentUUID: 'root-uuid' }]
            };
            expect(traceMessages(state, [child]).map((m) => m.sidechainId)).toEqual(['a']);
        });

        it('buffers an orphan delivered twice only once (#388)', () => {
            const state = createTracer();
            const orphan: NormalizedMessage = {
                id: 'orphan',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'text', text: 'early', uuid: 'orphan-uuid', parentUUID: 'missing-parent' }]
            };
            traceMessages(state, [orphan]);
            traceMessages(state, [orphan]);
            expect(state.orphanMessages.get('missing-parent')).toHaveLength(1);

            const parent: NormalizedMessage = {
                id: 'parent',
                localId: null,
                createdAt: 500,
                role: 'agent',
                isSidechain: false,
                content: [{ type: 'tool-call', id: 'missing-parent', name: 'Task', input: { prompt: 'P' }, description: null, uuid: 'p-uuid', parentUUID: null }]
            };
            const released = traceMessages(state, [parent]);
            expect(released.filter((m) => m.id === 'orphan')).toHaveLength(1);
        });

        it('gives parallel Task calls in one message their own sidechains (#396)', () => {
            const state = createTracer();
            const twoTasks: NormalizedMessage = {
                id: 'both',
                localId: null,
                createdAt: 1000,
                role: 'agent',
                isSidechain: false,
                content: [
                    { type: 'tool-call', id: 'tA', name: 'Task', input: { prompt: 'A' }, description: null, uuid: 'u', parentUUID: null },
                    { type: 'tool-call', id: 'tB', name: 'Task', input: { prompt: 'B' }, description: null, uuid: 'u', parentUUID: null },
                ]
            };
            traceMessages(state, [twoTasks]);
            const roots = traceMessages(state, [
                { id: 'rB', localId: null, createdAt: 2, role: 'agent', isSidechain: true, content: [{ type: 'sidechain', uuid: 'rb-uuid', prompt: 'B' }] },
                { id: 'rA', localId: null, createdAt: 3, role: 'agent', isSidechain: true, content: [{ type: 'sidechain', uuid: 'ra-uuid', prompt: 'A' }] },
            ]);
            expect(roots.map((m) => [m.id, m.sidechainId])).toEqual([['rB', 'tB'], ['rA', 'tA']]);
        });

        it('should skip already processed messages', () => {
            const state = createTracer();
            const message: NormalizedMessage = {
                id: 'msg1',
                localId: null,
                createdAt: 1000,
                role: 'user',
                isSidechain: false,
                content: { type: 'text', text: 'Hello' }
            };

            // Process once
            const traced1 = traceMessages(state, [message]);
            expect(traced1).toHaveLength(1);

            // Process again
            const traced2 = traceMessages(state, [message]);
            expect(traced2).toHaveLength(0);
        });
    });
});

describe('deep orphan chains (#389)', () => {
    const uuidAt = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const chained = (i: number): NormalizedMessage => ({
        id: `sc-${i}`,
        localId: null,
        createdAt: 3000 + i,
        role: 'agent',
        isSidechain: true,
        content: [{ type: 'text', text: `step ${i}`, uuid: uuidAt(i), parentUUID: uuidAt(i - 1) }],
    });

    it('releases a 10,000-message chain iteratively, in order, without losing any message', () => {
        const state = createTracer();
        const N = 10_000;
        // History paged backward: every descendant arrives before its parent → all buffered.
        const buffered = traceMessages(state, Array.from({ length: N }, (_, k) => chained(N - k)));
        expect(buffered).toHaveLength(0);
        expect(state.orphanMessages.size).toBe(N);

        traceMessages(state, [{
            id: 'task', localId: null, createdAt: 1000, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'tool1', name: 'Task', input: { prompt: 'deep' }, description: null, uuid: 'task-uuid', parentUUID: null }],
        }]);

        const t0 = performance.now();
        const released = traceMessages(state, [{
            id: 'root', localId: null, createdAt: 2000, role: 'agent', isSidechain: true,
            content: [{ type: 'sidechain', uuid: uuidAt(0), prompt: 'deep' }],
        }]);
        // Generous bound: the property under test is linear time, and the
        // suite shares the machine with other work.
        expect(performance.now() - t0).toBeLessThan(500);

        expect(released).toHaveLength(N + 1);
        expect(released[0].id).toBe('root');
        expect(released.slice(1).map(m => m.id)).toEqual(Array.from({ length: N }, (_, k) => `sc-${k + 1}`));
        expect(released.every(m => m.sidechainId === 'tool1')).toBe(true);
        expect(state.orphanMessages.size).toBe(0);
        expect(state.processedIds.size).toBe(N + 2);
    });

    it('releases 150,000 buffered descendants without a stack overflow, marking each only as it is emitted', () => {
        const state = createTracer();
        const N = 150_000;
        // A chain 100 deep, 1,500 wide at every level: every message buffered
        // before its parent (backward paging), so the release must walk and
        // APPEND iteratively — a spread into push threw RangeError here.
        const depth = 100;
        const width = N / depth;
        const parentOf = (i: number) => (i <= width ? uuidAt(0) : uuidAt(i - width));
        const messages: NormalizedMessage[] = [];
        for (let i = N; i >= 1; i--) {
            messages.push({
                id: `w-${i}`,
                localId: null,
                createdAt: 3000 + i,
                role: 'agent',
                isSidechain: true,
                content: [{ type: 'text', text: `w ${i}`, uuid: uuidAt(i), parentUUID: parentOf(i) }],
            });
        }
        expect(traceMessages(state, messages)).toHaveLength(0);
        expect(state.processedIds.size).toBe(0);

        traceMessages(state, [{
            id: 'task', localId: null, createdAt: 1000, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 'tool-wide', name: 'Task', input: { prompt: 'wide' }, description: null, uuid: 'task-uuid', parentUUID: null }],
        }]);
        let released: ReturnType<typeof traceMessages> = [];
        expect(() => {
            released = traceMessages(state, [{
                id: 'root', localId: null, createdAt: 2000, role: 'agent', isSidechain: true,
                content: [{ type: 'sidechain', uuid: uuidAt(0), prompt: 'wide' }],
            }]);
        }).not.toThrow();
        expect(released).toHaveLength(N + 1);
        expect(released.every(m => m.sidechainId === 'tool-wide')).toBe(true);
        expect(state.orphanMessages.size).toBe(0);
        // root + task + every descendant — nothing consumed that was not returned.
        expect(state.processedIds.size).toBe(N + 2);
        const ids = new Set(released.map(m => m.id));
        expect(ids.size).toBe(N + 1);
    });

    it('keeps depth-first emit order for branching orphans', () => {
        const state = createTracer();
        const child = (id: string, uuid: string, parent: string): NormalizedMessage => ({
            id, localId: null, createdAt: 1, role: 'agent', isSidechain: true,
            content: [{ type: 'text', text: id, uuid, parentUUID: parent }],
        });
        const A = uuidAt(1), B = uuidAt(2), A1 = uuidAt(3), B1 = uuidAt(4), root = uuidAt(0);
        traceMessages(state, [child('a1', A1, A), child('b1', B1, B), child('a', A, root), child('b', B, root)]);
        traceMessages(state, [{
            id: 'task', localId: null, createdAt: 1000, role: 'agent', isSidechain: false,
            content: [{ type: 'tool-call', id: 't', name: 'Task', input: { prompt: 'p' }, description: null, uuid: 'tu', parentUUID: null }],
        }]);
        const out = traceMessages(state, [{
            id: 'root', localId: null, createdAt: 2000, role: 'agent', isSidechain: true,
            content: [{ type: 'sidechain', uuid: root, prompt: 'p' }],
        }]);
        expect(out.map(m => m.id)).toEqual(['root', 'a', 'a1', 'b', 'b1']);
    });
});
