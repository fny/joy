import * as React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ChatList } from '@/components/ChatList';
import { storage, useSession } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { createReducer } from '@/sync/reducer/reducer';
import type { Message } from '@/sync/typesMessage';
import type { Session } from '@/sync/storageTypes';

// Chat scroll lab: the real ChatList over a fake session, with a streaming
// simulator and (web) a scroll trace that flags every downward move the user
// did not make. Drive it from a browser: window.__lab.stream(true), wheel up,
// then read window.__lab.jumps().

const LAB_SESSION_ID = 'lab-chat-scroll';
const LOREM = 'The quick brown fox jumps over the lazy dog while the build runs and the tests settle into place. ';

function para(n: number): string {
    return Array.from({ length: n }, (_, i) => `${i % 3 === 0 ? '**Step.** ' : ''}${LOREM.repeat(1 + (i % 3))}`).join('\n\n');
}

// Seeded, so two runs stream the same sequence and their traces compare.
let rngState = 0x2f6b1d;
function rand(): number {
    rngState = (rngState * 1103515245 + 12345) & 0x7fffffff;
    return rngState / 0x7fffffff;
}

let clock = 1_700_000_000_000;
let seq = 1;
function id(prefix: string) { return `${prefix}-${seq}`; }

function userText(text: string): Message {
    const m: Message = { kind: 'user-text', id: id('u'), seq, localId: null, createdAt: clock, text };
    seq++; clock += 1000;
    return m;
}
function agentText(text: string): Message {
    const m: Message = { kind: 'agent-text', id: id('a'), seq, localId: null, createdAt: clock, text };
    seq++; clock += 1000;
    return m;
}
function toolCall(command: string, state: 'running' | 'completed' = 'completed'): Message {
    const m: Message = {
        kind: 'tool-call', id: id('t'), seq, localId: null, createdAt: clock, children: [],
        tool: {
            name: 'Bash', state, input: { command, description: command },
            createdAt: clock, startedAt: clock, completedAt: state === 'completed' ? clock + 500 : null,
            description: command, result: state === 'completed' ? 'ok\n'.repeat(3) : undefined,
        },
    };
    seq++; clock += 1000;
    return m;
}

function history(turns: number): Message[] {
    const out: Message[] = [];
    for (let t = 0; t < turns; t++) {
        out.push(userText(`Prompt ${t}: please look at the scroll behaviour ${t % 4 === 0 ? 'and explain it in detail' : ''}`));
        for (let k = 0; k < 1 + (t % 4); k++) out.push(toolCall(`rg -n scroll src/${t}/${k}`));
        out.push(agentText(`Answer ${t}.\n\n${para(1 + (t % 5))}`));
    }
    return out;
}

function fakeSession(thinking: boolean): Session {
    return {
        id: LAB_SESSION_ID, seq: 0, createdAt: clock, updatedAt: clock, active: true, activeAt: clock,
        metadata: { path: '/lab', host: 'lab' } as Session['metadata'], metadataVersion: 0,
        agentState: null, agentStateVersion: 0, thinking, thinkingAt: clock, presence: 'online',
    };
}

// Older history is paged in like the real sync does: the lab holds the whole
// conversation and reveals it from the newest end, one page per onStartReached.
const paging = { hidden: 0, loading: false, pageMessages: 150, delayMs: 700 };

/** Newest-first, as the store keeps them. */
function write(messages: Message[], thinking: boolean) {
    const shown = messages.slice(paging.hidden);
    const sorted = [...shown].sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
    const map: Record<string, Message> = {};
    for (const m of sorted) map[m.id] = m;
    storage.setState((s) => ({
        ...s,
        sessions: { ...s.sessions, [LAB_SESSION_ID]: fakeSession(thinking) },
        sessionMessages: {
            ...s.sessionMessages,
            [LAB_SESSION_ID]: { messages: sorted, messagesMap: map, reducerState: createReducer(), isLoaded: true, hasMoreOlder: paging.hidden > 0, isLoadingOlder: paging.loading },
        },
    }));
}

type TraceEvent = { t: number; kind: 'scroll' | 'wheel' | 'stream'; top?: number; max?: number; dy?: number; note?: string };

export default React.memo(function ChatScrollLab() {
    const messagesRef = React.useRef<Message[]>([]);
    const streamingRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
    const [streaming, setStreaming] = React.useState(false);
    const session = useSession(LAB_SESSION_ID);

    React.useEffect(() => {
        messagesRef.current = history(240);
        paging.hidden = Math.max(0, messagesRef.current.length - 200);
        write(messagesRef.current, false);
        const realLoadOlder = sync.loadOlderMessages;
        sync.loadOlderMessages = async (sid: string) => {
            if (sid !== LAB_SESSION_ID) return realLoadOlder(sid);
            if (paging.loading || paging.hidden === 0) return;
            paging.loading = true;
            write(messagesRef.current, streamingRef.current !== null);
            trace.push({ t: performance.now(), kind: 'stream', note: 'older:start' });
            await new Promise((r) => setTimeout(r, paging.delayMs));
            paging.hidden = Math.max(0, paging.hidden - paging.pageMessages);
            paging.loading = false;
            write(messagesRef.current, streamingRef.current !== null);
            trace.push({ t: performance.now(), kind: 'stream', note: 'older:done' });
        };
        return () => {
            sync.loadOlderMessages = realLoadOlder;
            if (streamingRef.current) clearInterval(streamingRef.current);
            storage.setState((s) => {
                const { [LAB_SESSION_ID]: _a, ...sessions } = s.sessions;
                const { [LAB_SESSION_ID]: _b, ...sessionMessages } = s.sessionMessages;
                return { ...s, sessions, sessionMessages };
            });
        };
    }, []);

    // One streaming tick: grow the reply, now and then add a tool row or a
    // whole new turn — the three shapes of live growth the chat sees.
    const tick = React.useCallback(() => {
        const msgs = messagesRef.current;
        const last = msgs[msgs.length - 1];
        const roll = rand();
        if (roll < 0.15) msgs.push(toolCall(`cargo test step ${seq}`));
        else if (last?.kind === 'agent-text') {
            msgs[msgs.length - 1] = { ...last, text: last.text + ' ' + LOREM };
        } else msgs.push(agentText('Streaming reply. '));
        write(msgs, true);
        trace.push({ t: performance.now(), kind: 'stream', note: roll < 0.15 ? 'tool' : 'grow' });
    }, []);

    const setStream = React.useCallback((on: boolean) => {
        if (streamingRef.current) { clearInterval(streamingRef.current); streamingRef.current = null; }
        if (on) {
            messagesRef.current.push(userText(`Live prompt ${seq}`));
            streamingRef.current = setInterval(tick, 120);
        } else {
            write(messagesRef.current, false);
        }
        setStreaming(on);
    }, [tick]);

    // Web trace: every scroll of the list's node and every wheel event.
    React.useEffect(() => {
        if (Platform.OS !== 'web') return;
        let node: HTMLElement | null = null;
        const onScroll = (e: Event) => {
            const el = e.target as HTMLElement;
            if (!el || typeof el.scrollTop !== 'number' || el.scrollHeight <= el.clientHeight + 10) return;
            node = el;
            trace.push({ t: performance.now(), kind: 'scroll', top: el.scrollTop, max: el.scrollHeight - el.clientHeight });
        };
        const onWheel = (e: WheelEvent) => trace.push({ t: performance.now(), kind: 'wheel', dy: e.deltaY });
        // Visual jumps: follow the element under the viewport centre frame by
        // frame. Content moving UP on screen (toward newer) with no downward
        // wheel in the last 200ms is the list pushing the reader, whatever
        // scrollTop did (MVCP corrections move scrollTop but not the content).
        // Identity is the element's text, not the node: FlashList recycles
        // cells, so a connected node can come to hold another message.
        let anchor: Element | null = null; let anchorText = ''; let anchorTop = 0; let raf = 0;
        const textOf = (el: Element | null) => (el?.textContent ?? '').slice(0, 80);
        const frame = () => {
            raf = requestAnimationFrame(frame);
            const n = node; if (!n) return;
            const r = n.getBoundingClientRect();
            if (anchor && anchor.isConnected && anchorText && textOf(anchor) === anchorText) {
                const top = anchor.getBoundingClientRect().top;
                const d = top - anchorTop;
                if (Math.abs(d) > 30) {
                    const now = performance.now();
                    const wheels = trace.filter((w) => w.kind === 'wheel' && w.t > now - 200).map((w) => w.dy!);
                    const explained = d < 0 ? wheels.some((dy) => dy > 0) : wheels.some((dy) => dy < 0);
                    if (!explained) visual.push({ t: Math.round(now), dy: Math.round(d), dir: d < 0 ? 'toward-newer' : 'toward-older', fromBottom: Math.round(n.scrollHeight - n.clientHeight - n.scrollTop), wheels });
                }
            }
            const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            anchor = el; anchorText = textOf(el); anchorTop = el ? el.getBoundingClientRect().top : 0;
        };
        raf = requestAnimationFrame(frame);
        document.addEventListener('scroll', onScroll, true);
        document.addEventListener('wheel', onWheel, true);
        (globalThis as any).__lab = {
            stream: (on: boolean) => setStream(on),
            // Content below the reader shrinks: the newest reply is cut to one
            // line (a fold, a re-render) — the clamp-to-bottom case.
            shrink: () => {
                // Cut every agent reply in the newest 12 messages to one line.
                const msgs = messagesRef.current;
                for (let i = msgs.length - 1; i >= Math.max(0, msgs.length - 12); i--) {
                    const m = msgs[i];
                    if (m.kind === 'agent-text') msgs[i] = { ...m, text: 'Short.' };
                }
                write(msgs, streamingRef.current !== null);
                trace.push({ t: performance.now(), kind: 'stream', note: 'shrink' });
            },
            tall: () => { messagesRef.current.push(agentText(para(14))); write(messagesRef.current, streamingRef.current !== null); },
            pause: () => { if (streamingRef.current) { clearInterval(streamingRef.current); streamingRef.current = null; } },
            resume: () => { if (!streamingRef.current) streamingRef.current = setInterval(tick, 120); },
            clear: () => { trace.length = 0; visual.length = 0; },
            visual: () => visual,
            trace: () => trace,
            node: () => node,
            jumps: () => findJumps(trace),
            notes: () => trace.filter((e) => e.kind === 'stream' && e.note !== 'grow' && e.note !== 'tool'),
            paging: () => ({ ...paging }),
        };
        return () => {
            cancelAnimationFrame(raf);
            document.removeEventListener('scroll', onScroll, true);
            document.removeEventListener('wheel', onWheel, true);
        };
    }, [setStream]);

    if (!session) return null;
    return (
        <View style={styles.container}>
            <View style={styles.bar}>
                <Pressable onPress={() => setStream(!streaming)} style={styles.button}>
                    <Text style={styles.buttonText}>{streaming ? 'Stop streaming' : 'Start streaming'}</Text>
                </Pressable>
            </View>
            <ChatList session={session} />
        </View>
    );
});

const trace: TraceEvent[] = [];
const visual: Array<{ t: number; dy: number; dir: string; fromBottom: number; wheels: number[] }> = [];

/** Downward moves (toward the newest message) of more than 40px that no
 *  downward wheel input in the preceding 250ms explains. */
function findJumps(events: TraceEvent[]) {
    const jumps: Array<{ t: number; from: number; to: number; max: number; distanceFromBottomAfter: number; recentWheel: number[] }> = [];
    let prev: TraceEvent | null = null;
    for (const e of events) {
        if (e.kind !== 'scroll') continue;
        if (prev && e.top! - prev.top! > 40) {
            const wheels = events.filter((w) => w.kind === 'wheel' && w.t <= e.t && w.t > e.t - 250).map((w) => w.dy!);
            if (!wheels.some((dy) => dy > 0)) {
                jumps.push({ t: Math.round(e.t), from: Math.round(prev.top!), to: Math.round(e.top!), max: Math.round(e.max!), distanceFromBottomAfter: Math.round(e.max! - e.top!), recentWheel: wheels });
            }
        }
        prev = e;
    }
    return jumps;
}

const styles = StyleSheet.create((theme) => ({
    container: { flex: 1, backgroundColor: theme.colors.surface },
    bar: { flexDirection: 'row', padding: 8, gap: 8 },
    button: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 6, backgroundColor: theme.colors.divider },
    buttonText: { color: theme.colors.text },
}));
