/**
 * The file screen renders the file/diff RESOURCES directly (sync/fileContents):
 * a later write to the cache — a save in the file panel, an authoritative
 * empty diff from the daemon, a failed revalidation — must reach the screen
 * without a local copy in between (review E4 follow-up).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { SESSION, ABS, theme, ops, storageState, storage, b64 } = vi.hoisted(() => {
    const b64 = (s: string): string => Buffer.from(s).toString('base64');
    const SESSION = 's';
    const ABS = '/repo/a';
    const theme = {
        colors: {
            text: 'black', textSecondary: 'gray', textLink: 'blue', textDestructive: 'red',
            surface: 'white', surfaceHigh: 'white', divider: 'gray', warning: 'orange',
            status: { error: 'red' }, button: { primary: { background: 'blue', tint: 'white' } },
            diff: {}, input: { background: 'white' },
        },
    };
    type ReadResult = { success: boolean; content?: string; error?: string };
    type DiffResult = { success: boolean; diff?: string; error?: string };
    const ops = {
        sessionReadFile: vi.fn(async (_sid: string, _path: string): Promise<ReadResult> => ({ success: true, content: b64('CURRENT') })),
        sessionGitDiff: vi.fn(async (): Promise<DiffResult> => ({ success: true, diff: '' })),
        sessionDeleteFile: vi.fn(async () => ({ success: true })),
    };
    const sessions: Record<string, { metadata: { path: string } }> = { [SESSION]: { metadata: { path: '/repo' } } };
    const storageState = { socketStatus: 'connected', isDataReady: true, sessions };
    const storage = Object.assign((selector: (s: typeof storageState) => unknown) => selector(storageState), {
        getState: () => storageState,
        subscribe: () => () => {},
    });
    return { SESSION, ABS, theme, ops, storageState, storage, b64 };
});

vi.mock('react-native', () => ({
    View: 'View', ScrollView: 'ScrollView', ActivityIndicator: 'Spinner', Pressable: 'Pressable',
    Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
    AppState: { addEventListener: () => ({ remove() {} }) },
}));
vi.mock('expo-router', () => ({
    useFocusEffect: () => {},
    useLocalSearchParams: () => ({ id: SESSION, path: ABS }),
    useRouter: () => ({ back() {}, push() {} }),
}));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme }),
    StyleSheet: { create: (x: unknown) => (typeof x === 'function' ? x(theme) : x), hairlineWidth: 1 },
}));
vi.mock('@expo/vector-icons/Ionicons', () => ({ default: () => null }));
vi.mock('@/components/StyledText', () => ({ Text: 'Text' }));
vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}), mono: () => ({}) } }));
vi.mock('@/components/layout', () => ({ layout: {} }));
vi.mock('@/components/FileIcon', () => ({ FileIcon: () => null }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/sync/storage', () => ({
    storage,
    useSession: () => storageState.sessions[SESSION],
    useLocalSettingMutable: () => [14, () => {}],
}));
vi.mock('@/hooks/useActiveInterval', () => ({ useActiveInterval: () => {} }));
vi.mock('@/utils/pathParam', () => ({ decodePathParam: (p: string) => p }));
vi.mock('@/sync/demoSession', () => ({ isDemoSession: () => false }));
vi.mock('@/components/SimpleSyntaxHighlighter', () => ({ SimpleSyntaxHighlighter: 'Syntax' }));
vi.mock('@/sync/ops', () => ops);
vi.mock('@/utils/clipboard', () => ({ copyToClipboard: async () => true }));
vi.mock('@/utils/guardAsync', () => ({ guarded: (fn: unknown) => fn, logError: () => {} }));
vi.mock('@/sync/persistence', () => ({ storeTempText: () => '' }));
vi.mock('@/modal', () => ({ Modal: { alert() {}, confirm: async () => false } }));
vi.mock('@/components/FileContentRender', () => ({ FileRenderedView: 'Rendered', fileRenderKind: () => null, isRasterImagePath: () => false }));
vi.mock('@/utils/downloadFile', () => ({ downloadFile: async () => {} }));

import { resources } from '@/sync/resource';
import { decodeFileContents, fileContentsKey, gitDiffKey } from '@/sync/fileContents';
import FileScreen from './file';

const FILE_KEY = fileContentsKey(SESSION, ABS);
const DIFF_KEY = gitDiffKey(SESSION, 'a');

/** Every string rendered anywhere in the tree. */
function text(h: ReactTestRenderer): string {
    return JSON.stringify(h.toJSON());
}

function syntaxCode(h: ReactTestRenderer): string | null {
    const nodes = h.root.findAllByType('Syntax');
    return nodes.length ? (nodes[0].props.code as string) : null;
}

/** The Pressable whose single Text child is `label` (a mode chip, a Retry). */
function chip(h: ReactTestRenderer, label: string) {
    return h.root.findAllByType('Pressable').find((n) => {
        const child = n.props.children as { props?: { children?: unknown } } | undefined;
        return child?.props?.children === label;
    });
}

function press(node: { props: Record<string, unknown> } | undefined): void {
    (node!.props.onPress as () => void)();
}

/** Settle the mount read: ensure() runs in an effect and resolves on microtasks. */
async function mount(): Promise<ReactTestRenderer> {
    let h!: ReactTestRenderer;
    await act(async () => { h = create(React.createElement(FileScreen)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return h;
}

describe('file screen renders the file and diff resources directly', () => {
    let h: ReactTestRenderer | null = null;

    beforeEach(() => {
        resources.remove(FILE_KEY);
        resources.remove(DIFF_KEY);
        ops.sessionReadFile.mockClear();
        ops.sessionGitDiff.mockClear();
        ops.sessionReadFile.mockImplementation(async () => ({ success: true, content: b64('CURRENT') }));
        ops.sessionGitDiff.mockImplementation(async () => ({ success: true, diff: '' }));
    });

    afterEach(async () => {
        if (h) await act(async () => { h!.unmount(); });
        h = null;
    });

    it('drops a cached patch once the daemon confirms an empty diff', async () => {
        resources.setData(FILE_KEY, decodeFileContents(ABS, b64('CACHED')));
        resources.setData(DIFF_KEY, '+OBSOLETE_PATCH');
        h = await mount();
        expect(resources.peek<string>(DIFF_KEY).data).toBe('');
        expect(text(h)).not.toContain('OBSOLETE_PATCH');
        expect(chip(h, 'files.diff')).toBeUndefined();
        // The revalidated file replaced the cached copy too.
        expect(syntaxCode(h)).toBe('CURRENT');
    });

    it('shows a save made elsewhere (setData) while keeping the chosen tab', async () => {
        ops.sessionGitDiff.mockImplementation(async () => ({ success: true, diff: '+LIVE_PATCH' }));
        h = await mount();
        // Diff-first by default; the user switches to File.
        expect(text(h)).toContain('LIVE_PATCH');
        expect(syntaxCode(h)).toBeNull();
        const fileChip = chip(h, 'files.file');
        expect(fileChip).toBeDefined();
        await act(async () => { press(fileChip); });
        expect(syntaxCode(h)).toBe('CURRENT');

        await act(async () => { resources.setData(FILE_KEY, decodeFileContents(ABS, b64('SAVED-ELSEWHERE'))); });
        expect(syntaxCode(h)).toBe('SAVED-ELSEWHERE');
        expect(text(h)).not.toContain('"CURRENT"');
        // Local intent survived the resource write: still on the File tab,
        // the diff chip still offered.
        expect(text(h)).not.toContain('LIVE_PATCH');
        expect(chip(h, 'files.diff')).toBeDefined();
    });

    it('keeps the last good content and shows a notice when a revalidation fails', async () => {
        resources.setData(FILE_KEY, decodeFileContents(ABS, b64('LAST-GOOD')));
        ops.sessionReadFile.mockImplementation(async () => ({ success: false, error: 'boom' }));
        h = await mount();
        expect(resources.peek(FILE_KEY).error).toBe('boom');
        expect(syntaxCode(h)).toBe('LAST-GOOD');
        expect(text(h)).toContain('files.refreshFailed');
        expect(text(h)).not.toContain('common.error');

        // A successful retry clears the notice.
        ops.sessionReadFile.mockImplementation(async () => ({ success: true, content: b64('FRESH') }));
        const retry = chip(h, 'common.retry');
        expect(retry).toBeDefined();
        await act(async () => { press(retry); await Promise.resolve(); await Promise.resolve(); });
        expect(syntaxCode(h)).toBe('FRESH');
        expect(text(h)).not.toContain('files.refreshFailed');
    });

    it('is an error screen when the first read fails with nothing cached', async () => {
        ops.sessionReadFile.mockImplementation(async () => ({ success: false, error: 'gone' }));
        h = await mount();
        expect(text(h)).toContain('common.error');
        expect(text(h)).toContain('gone');
        expect(syntaxCode(h)).toBeNull();
    });
});
