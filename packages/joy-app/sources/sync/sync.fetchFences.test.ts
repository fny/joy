/**
 * The fetch-generation fences in sync.ts, run against the REAL class members
 * (see syncMembers.testutil.ts):
 *   #407 a reset that lands while a page is being DECRYPTED writes nothing —
 *        applyFetchedMessages checks the generation before every store write;
 *   #406 forgetSession invalidates with a unique generation, so a page in
 *        flight for the removed session cannot restore its messages/cursor;
 *   #12  a send that re-anchors an evicted store also invalidates the forward
 *        page already in flight, so it cannot put a forward-only cursor back.
 */
import { describe, it, expect } from 'vitest';
import { FetchGeneration, StaleFetchError, cursorsNeedReanchor, isSendAcknowledged } from './sessionSyncGuards';
import { buildSyncSubset } from './syncMembers.testutil';

const defer = <T,>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
};
const quiet = { log: () => { } };

function baseInstance(Sync: ReturnType<typeof buildSyncSubset>) {
    const x = new Sync();
    for (const p of ['sessionLastSeq', 'sessionOldestSeq', 'unopenableStrikes', 'unopenableGaps', 'messagesSync', 'sessionMessageLocks', 'recentSendAt']) x[p] = new Map();
    x.replayUnopenableGap = async () => { }; // #128 gap replay has its own test file
    x.fetchGen = new FetchGeneration();
    x.applyLifecycle = () => { };
    x.v2ReadCtx = () => ({ key: new Uint8Array(32) });
    return x;
}

describe('applyFetchedMessages (#407)', () => {
    function build() {
        const applied: unknown[] = [];
        const sessionsApplied: unknown[] = [];
        const state = { sessions: { A: { id: 'A', thinking: false } } };
        const Sync = buildSyncSubset(['applyFetchedMessages', 'assertFresh'], {
            normalizeRawMessage: (id: string, _l: unknown, _c: unknown, content: unknown) => ({ id, content }),
            deriveThinkingFromContent: (c: unknown) => (c === 'TURN_START' ? true : null),
            storage: { getState: () => state },
            StaleFetchError,
        });
        const x = baseInstance(Sync);
        x.applyMessages = (_s: string, msgs: unknown[]) => applied.push(...msgs);
        x.applySessions = (s: unknown[]) => sessionsApplied.push(...s);
        return { x, applied, sessionsApplied };
    }

    it('a reset during decryption commits neither the message nor the thinking state', async () => {
        const { x, applied, sessionsApplied } = build();
        const decrypt = defer<unknown[]>();
        const gen = x.fetchGen.current('A');
        const p = x.applyFetchedMessages('A', { decryptMessages: () => decrypt.promise }, [{ seq: 101 }], gen, { deriveThinking: true });
        x.fetchGen.bump('A'); // resetSessionChatState while the page is being decrypted
        decrypt.resolve([{ id: 'old', createdAt: 1, seq: 101, content: 'TURN_START' }]);
        await expect(p).rejects.toBeInstanceOf(StaleFetchError);
        expect(applied).toEqual([]);
        expect(sessionsApplied).toEqual([]);
    });

    it('an unreset fetch still commits the message and the thinking flag', async () => {
        const { x, applied, sessionsApplied } = build();
        const gen = x.fetchGen.current('A');
        await x.applyFetchedMessages('A', { decryptMessages: async (m: unknown[]) => m.map((r: any) => ({ ...r, id: 'm' + r.seq, content: 'TURN_START' })) }, [{ seq: 101 }], gen, { deriveThinking: true });
        expect(applied).toHaveLength(1);
        expect(sessionsApplied).toEqual([expect.objectContaining({ id: 'A', thinking: true })]);
    });
});

describe('forgetSession (#406)', () => {
    function build() {
        const page = defer<unknown>();
        let removed = false;
        const rows: unknown[] = [];
        const filesForgotten: string[] = [];
        const Sync = buildSyncSubset(['fetchForwardSince', 'assertFresh', 'forgetSession'], {
            v2MessagesAfter: () => page.promise,
            log: quiet,
            StaleFetchError,
            storage: { getState: () => ({ deleteSession: () => { removed = true; } }) },
            gitStatusSync: { clearForSession: () => { } },
            clearGitStatusForSession: () => { }, // E4: the git resource replaced gitStatusSync
            forgetSessionFiles: (id: string) => { filesForgotten.push(id); }, // E4: the session's file/diff cache goes with it
        });
        const x = baseInstance(Sync);
        x.sessionLastSeq.set('A', 100);
        x.sessionOldestSeq.set('A', 50);
        x.applyFetchedMessages = async (_s: string, _e: unknown, m: unknown[]) => { rows.push(...m); };
        return { x, page, rows, removed: () => removed, filesForgotten };
    }

    it('a forward page in flight when the session is removed restores nothing', async () => {
        const { x, page, rows, removed, filesForgotten } = build();
        const gen = x.fetchGen.current('A'); // the generation the in-flight fetch captured (0)
        const p = x.fetchForwardSince('A', {}, 100, gen);
        x.forgetSession('A');
        page.resolve({ messages: [{ seq: 101 }], lifecycle: [], cursor: 101, hasMore: false });
        await expect(p).rejects.toBeInstanceOf(StaleFetchError);
        expect(removed()).toBe(true);
        expect(filesForgotten).toEqual(['A']); // the session's file/diff cache goes with it (E4)
        expect(rows).toEqual([]);
        expect(x.sessionLastSeq.has('A')).toBe(false);
        expect(x.sessionOldestSeq.has('A')).toBe(false);
    });

    it('the invalidation token is unique: a later forget cannot revalidate an older fetch', () => {
        const { x } = build();
        const captured = x.fetchGen.current('A');
        x.forgetSession('A');
        expect(x.fetchGen.isStale('A', captured)).toBe(true);
        // A re-listed session bumps again on its next removal; the first
        // capture never becomes valid again.
        x.fetchGen.bump('A');
        x.forgetSession('A');
        expect(x.fetchGen.isStale('A', captured)).toBe(true);
    });
});

describe('sendMessage re-anchor (#12)', () => {
    function build() {
        const page = defer<unknown>();
        const rows: unknown[] = [];
        const applied: unknown[] = [];
        const state = {
            sessions: { A: { id: 'A', metadata: { v2: { sessionId: 'v2-A', relay: 'https://relay', keyEnvelope: 'v2:plaintext' } } } },
            sessionMessages: {} as Record<string, unknown>, // limitSessionMemory evicted the store
            applyMessages: (_s: string, m: unknown[]) => { applied.push(...m); state.sessionMessages.A = { reducerState: { localIds: new Map() }, messagesMap: {} }; },
            bindTurnToLocal: () => { },
            applyDeliveryStage: () => { },
            dismissLocalMessage: () => { },
        };
        const Sync = buildSyncSubset(['sendMessage', 'localRow', 'fetchForwardSince', 'assertFresh'], {
            v2MessagesAfter: () => page.promise,
            log: quiet,
            StaleFetchError,
            storage: { getState: () => state },
            randomUUID: () => 'local-1',
            cursorsNeedReanchor,
            isSendAcknowledged,
            sealV2Content: (text: string) => JSON.stringify({ v: 1, t: 'plain', text }),
            v2SendCiphertext: async () => ({ messageId: 'm1', turnId: 't1' }),
            V2ApiError: class extends Error { },
            Modal: { alert: () => { } },
            t: (k: string) => k,
            AttachmentRejected: class extends Error { },
            // the transpiled `import('@/-session/draftQueueRelease')`
            require: () => ({ notifyOutboxAcked: () => { } }),
        });
        const x = baseInstance(Sync);
        x.encryption = { getSessionEncryption: () => ({}), openV2SessionKey: () => null };
        x.sessionsSync = { awaitQueue: async () => { } };
        x.sessionLastSeq.set('A', 100); // cursors outlived the evicted store
        x.applyFetchedMessages = async (_s: string, _e: unknown, m: unknown[]) => { rows.push(...m); };
        return { x, page, rows, applied, state };
    }

    it('a forward page pending when the send re-anchors cannot restore a forward-only cursor', async () => {
        const { x, page, rows, applied } = build();
        const gen = x.fetchGen.current('A');
        const pending = x.fetchForwardSince('A', {}, 100, gen); // already in flight from seq 100

        const res = await x.sendMessage('A', 'hello');
        expect(res.ok).toBe(true);
        expect(applied).toHaveLength(1); // the optimistic row re-created the store
        expect(x.sessionLastSeq.has('A')).toBe(false);

        page.resolve({ messages: [{ seq: 101 }], lifecycle: [], cursor: 101, hasMore: false });
        await expect(pending).rejects.toBeInstanceOf(StaleFetchError);
        expect(rows).toEqual([]);
        // Still un-anchored: the next fetch takes the cold-open path (both cursors).
        expect(x.sessionLastSeq.has('A')).toBe(false);
        expect(x.sessionOldestSeq.has('A')).toBe(false);
    });

    it('a send into a loaded store leaves the pending forward page valid', async () => {
        const { x, page, rows, state } = build();
        state.sessionMessages.A = { reducerState: { localIds: new Map() }, messagesMap: {} }; // store present
        const gen = x.fetchGen.current('A');
        const pending = x.fetchForwardSince('A', {}, 100, gen);
        expect((await x.sendMessage('A', 'hello')).ok).toBe(true);
        page.resolve({ messages: [{ seq: 101 }], lifecycle: [], cursor: 101, hasMore: false });
        await pending;
        expect(rows).toHaveLength(1);
        expect(x.sessionLastSeq.get('A')).toBe(101);
    });
});
