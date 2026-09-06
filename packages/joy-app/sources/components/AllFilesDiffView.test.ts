import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The REAL AllFilesDiffView rendered with react-test-renderer over the real
// resource store and hooks; native rendering, the daemon transport and the
// git status resource are the mocked boundaries.
//  - #199: a status revision that advances during a section's first read
//    produces ONE trailing read, and its answer is what is shown;
//  - #91: a path removed while its read is pending and re-added under a new
//    revision is read again — the pre-removal answer is not its content;
//  - a failed status with nothing cached is an error with Retry, not
//    "no changes"; a last good status whose check failed shows the diffs
//    WITH a retryable stale notice.

type ReadAnswer = { success: boolean; content?: string; error?: string };
const reads: Array<{ path: string; resolve: (a: ReadAnswer) => void }> = [];
const colors = new Proxy({}, { get: () => '#000' });
const theme = { colors };

vi.mock('react-native', () => ({
    View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'ActivityIndicator', Pressable: 'Pressable',
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
    AppState: { addEventListener: () => ({ remove: () => {} }) },
}));
vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (s: unknown) => (typeof s === 'function' ? s(theme) : s), hairlineWidth: 1 },
    useUnistyles: () => ({ theme }),
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: 'Ionicons' }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/components/FileIcon', () => ({ FileIcon: 'FileIcon' }));
vi.mock('@/components/diff/PierreDiffView', () => ({ PierreDiffView: 'PierreDiffView' }));
vi.mock('@/components/diff/calculateDiff', () => ({ getPatchDiffStats: () => ({ additions: 0, deletions: 0 }) }));
vi.mock('@/components/JoyImage', () => ({ JoyImage: 'JoyImage' }));
vi.mock('@/components/layout', () => ({ layout: { maxWidth: 800 } }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }));
vi.mock('@/hooks/useActiveInterval', () => ({ useActiveInterval: () => {} }));
vi.mock('@/sync/storage', () => ({
    storage: { getState: () => ({ socketStatus: 'connected', sessions: {} }), subscribe: () => () => {} },
    useSession: () => ({ metadata: { path: '/repo' } }),
    useSettingMutable: () => ['unified', () => {}],
}));
vi.mock('@/sync/ops', () => ({
    sessionReadFile: (_s: string, path: string) => new Promise<ReadAnswer>((resolve) => { reads.push({ path, resolve }); }),
    sessionGitDiff: () => new Promise(() => {}),
}));

type Status = {
    entry: { hasData: boolean; data: unknown };
    files: { stagedFiles: unknown[]; unstagedFiles: unknown[] } | null;
    error: string | null;
    unavailable: string | null;
    isLoading: boolean;
    revision: number;
    refresh: () => Promise<unknown>;
};
let status: Status;
vi.mock('@/sync/gitStatusResource', () => ({ useGitStatusResource: () => status }));

import { AllFilesDiffView } from './AllFilesDiffView';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const row = (fullPath: string) => ({
    fullPath, fileName: fullPath, filePath: '', displayPath: fullPath, utf8: true, unaddressable: false,
    status: 'untracked', isStaged: false, lines: { added: 0, removed: 0 }, binary: false,
});
const withFiles = (rows: unknown[], extra: Partial<Status> = {}): Status => ({
    entry: { hasData: true, data: {} }, files: { stagedFiles: [], unstagedFiles: rows }, error: null, unavailable: null,
    isLoading: false, revision: 1, refresh: async () => {}, ...extra,
});
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
type Root = ReturnType<typeof create>;
type Instance = { type: unknown; props: Record<string, unknown>; findAll(pred: (n: Instance) => boolean): Instance[] };
const tree = (root: Root) => root.root as unknown as Instance;
type SectionResult = { file: { fullPath: string }; content: { contents?: string } | null; error: string | null; stale: string | null };
const props = { sessionId: 's' };
// A fresh callback per render: the component is memoized, and a status
// change reaches it through the (mocked) hook, not through props.
const element = () => React.createElement(AllFilesDiffView, { sessionId: props.sessionId, onHeaderRightSlotChange: () => {} });
/** The rendered sections' results (one per file on screen). */
const sections = (root: Root) => {
    const seen = new Map<string, SectionResult>();
    for (const n of tree(root).findAll((x) => x.props.result !== undefined && x.props.onRetry !== undefined)) {
        const result = n.props.result as SectionResult;
        seen.set(result.file.fullPath, result);
    }
    return Array.from(seen.values());
};
/** The first rendered button (the Retry of an error view / stale notice). */
const firstButton = (root: Root) => {
    const n = tree(root).findAll((x) => x.type === 'Pressable' && x.props.accessibilityRole === 'button')[0];
    return { press: () => (n.props.onPress as () => void)() };
};
const rendered = (root: Root) => JSON.stringify(root.toJSON());

let sessionN = 0;
beforeEach(() => { reads.length = 0; props.sessionId = `s${++sessionN}`; });

describe('AllFilesDiffView — the trailing-version contract', () => {
    it('#199: a revision that advances during the first read yields one trailing read whose answer is shown', async () => {
        status = withFiles([row('a')], { revision: 1 });
        let root!: Root;
        await act(async () => { root = create(element()); });
        expect(reads.length).toBe(1);
        status = withFiles([row('a')], { revision: 2 });
        await act(async () => { root.update(element()); });
        expect(reads.length).toBe(1); // the active read is not doubled
        await act(async () => { reads[0].resolve({ success: true, content: b64('OLD') }); await tick(); });
        expect(sections(root)[0]?.content?.contents).toBe('OLD'); // last good, while the trailing read runs
        expect(reads.length).toBe(2);
        await act(async () => { reads[1].resolve({ success: true, content: b64('NEW') }); await tick(); });
        expect(sections(root)[0]?.content?.contents).toBe('NEW');
        expect(reads.length).toBe(2);
        await act(async () => { root.unmount(); });
    });

    it('#91: a path removed during its read and re-added under a new revision is read again', async () => {
        status = withFiles([row('c')], { revision: 5 });
        let root!: Root;
        await act(async () => { root = create(element()); });
        expect(reads.length).toBe(1);
        const old = reads[0];
        status = withFiles([], { revision: 5 });
        await act(async () => { root.update(element()); });
        expect(sections(root)).toEqual([]);
        status = withFiles([row('c')], { revision: 6 });
        await act(async () => { root.update(element()); });
        expect(reads.length).toBe(1); // the new incarnation waits for the old read, then reads for ITS revision
        await act(async () => { old.resolve({ success: true, content: b64('PRE-REMOVAL') }); await tick(); });
        expect(reads.length).toBe(2);
        await act(async () => { reads[1].resolve({ success: true, content: b64('NEW-INCARNATION') }); await tick(); });
        expect(sections(root)[0]?.content?.contents).toBe('NEW-INCARNATION');
        await act(async () => { root.unmount(); });
    });
});

describe('AllFilesDiffView — the status resource\'s states are kept apart', () => {
    it('a failed status with nothing cached is an error with Retry, not "no changes"', async () => {
        const refresh = vi.fn(async () => ({}));
        status = { entry: { hasData: false, data: undefined }, files: null, error: 'git failed', unavailable: null, isLoading: false, revision: 0, refresh };
        let root!: Root;
        await act(async () => { root = create(element()); });
        const out = rendered(root);
        expect(out).toContain('files.statusFailed');
        expect(out).toContain('git failed');
        expect(out).not.toContain('files.noChanges');
        await act(async () => { firstButton(root).press(); });
        expect(refresh).toHaveBeenCalledTimes(1);
        await act(async () => { root.unmount(); });
    });

    it('no answer yet is a spinner; the daemon\'s explicit "not a repository" is its own message', async () => {
        status = { entry: { hasData: false, data: undefined }, files: null, error: null, unavailable: null, isLoading: true, revision: 0, refresh: async () => {} };
        let root!: Root;
        await act(async () => { root = create(element()); });
        expect(rendered(root)).toContain('ActivityIndicator');
        status = { entry: { hasData: true, data: null }, files: null, error: null, unavailable: null, isLoading: false, revision: 1, refresh: async () => {} };
        await act(async () => { root.update(element()); });
        expect(rendered(root)).toContain('files.notRepo');
        expect(rendered(root)).not.toContain('files.noChanges');
        await act(async () => { root.unmount(); });
    });

    it('a last good status whose check failed shows the diffs with a retryable stale notice', async () => {
        const refresh = vi.fn(async () => ({}));
        status = withFiles([row('a')], { revision: 1 });
        let root!: Root;
        await act(async () => { root = create(element()); });
        await act(async () => { reads[0].resolve({ success: true, content: b64('CONTENT') }); await tick(); });
        expect(sections(root)[0]?.content?.contents).toBe('CONTENT');
        expect(rendered(root)).not.toContain('files.statusStale');
        status = withFiles([row('a')], { revision: 1, error: 'git status HTTP 500', refresh });
        await act(async () => { root.update(element()); });
        const out = rendered(root);
        expect(out).toContain('files.statusStale');
        expect(out).toContain('git status HTTP 500');
        expect(sections(root)[0]?.content?.contents).toBe('CONTENT'); // still on screen
        await act(async () => { firstButton(root).press(); });
        expect(refresh).toHaveBeenCalledTimes(1);
        await act(async () => { root.unmount(); });
    });

    it('a section whose revalidation failed keeps its diff and shows a retryable stale line', async () => {
        status = withFiles([row('a')], { revision: 1 });
        let root!: Root;
        await act(async () => { root = create(element()); });
        await act(async () => { reads[0].resolve({ success: true, content: b64('CONTENT') }); await tick(); });
        status = withFiles([row('a')], { revision: 2 });
        await act(async () => { root.update(element()); });
        expect(reads.length).toBe(2);
        await act(async () => { reads[1].resolve({ success: false, error: 'read down' }); await tick(); });
        const s = sections(root)[0];
        expect(s?.content?.contents).toBe('CONTENT');
        expect(s?.stale).toBe('read down');
        expect(rendered(root)).toContain('files.diffStale');
        await act(async () => { root.unmount(); });
    });
});
