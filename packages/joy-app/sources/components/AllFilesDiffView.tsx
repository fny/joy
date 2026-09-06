import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { getPatchDiffStats } from '@/components/diff/calculateDiff';
import { sessionGitDiff, sessionReadFile } from '@/sync/ops';
import { isBinaryPath, isImagePath } from '@/utils/binaryFile';
import { JoyImage } from '@/components/JoyImage';
import { storage, useSessionGitStatusFiles, useSettingMutable } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { GitFileStatus } from '@/sync/gitStatusFiles';
import { layout } from '@/components/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';

interface AllFilesDiffViewProps {
    /** Show ONLY this file's diff (one-at-a-time mode). Absent → all files. */
    onlyFile?: string | null;
    sessionId: string;
    /** When set, auto-scroll to this file */
    scrollToFile?: string | null;
    /** Publishes the right-side controls (file count + diff style toggle) into the chat header. */
    onHeaderRightSlotChange: (slot: React.ReactNode) => void;
}

type DiffContent =
    | { kind: 'patch'; patch: string }
    | { kind: 'newFile'; contents: string }
    | { kind: 'binary' }
    | { kind: 'image'; path: string };

type FileDiffResult = {
    file: GitFileStatus;
    content: DiffContent | null;
    error: string | null;
};

/**
 * Loads all diffs in parallel, then renders them in a single ScrollView.
 * Shows a global loading spinner until all diffs are fetched to prevent layout jumps.
 */
export const AllFilesDiffView = React.memo(function AllFilesDiffView({
    sessionId,
    scrollToFile,
    onlyFile,
    onHeaderRightSlotChange,
}: AllFilesDiffViewProps) {
    const { theme } = useUnistyles();
    const gitStatusFiles = useSessionGitStatusFiles(sessionId);
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const scrollRef = React.useRef<ScrollView>(null);
    const fileOffsets = React.useRef<Map<string, number>>(new Map());

    // Flatten and deduplicate files
    const files = React.useMemo(() => {
        if (!gitStatusFiles) return [];
        const all = [...gitStatusFiles.stagedFiles, ...gitStatusFiles.unstagedFiles];
        const seen = new Map<string, GitFileStatus>();
        for (const f of all) {
            if (!seen.has(f.fullPath)) seen.set(f.fullPath, f);
        }
        const sorted = Array.from(seen.values()).sort((a, b) =>
            a.fullPath.localeCompare(b.fullPath)
        );
        // One-at-a-time: clicking a changed file shows just THAT file.
        return onlyFile ? sorted.filter((f) => f.fullPath === onlyFile) : sorted;
    }, [gitStatusFiles, onlyFile]);

    // Per-file diff cache keyed by fullPath. Reconciled incrementally as the
    // file set changes so the rendered ScrollView keeps its scroll position and
    // existing diff sections stay on screen while updated files refresh in the
    // background.
    const [resultsMap, setResultsMap] = React.useState<Map<string, FileDiffResult>>(() => new Map());
    // Signature of the last fetched version per fullPath. If the signature
    // (status + linesAdded + linesRemoved + isStaged) hasn't changed, the diff
    // for that file doesn't need to be re-fetched.
    const fetchedSignatures = React.useRef<Map<string, string>>(new Map());
    const inFlight = React.useRef<Set<string>>(new Set());
    /** The current file list, read when a fetch completes (#91). */
    const filesRef = React.useRef(files);
    filesRef.current = files;
    // Track whether we've ever populated results — only show the global spinner
    // on the very first load, not on subsequent file-set changes.
    const [hasLoadedOnce, setHasLoadedOnce] = React.useState(false);
    // Request generation per path: the empty-list branch clears inFlight while
    // old requests still run, so a path removed and re-added with the same
    // signature could have its NEW result overwritten by the OLD completion
    // (Astra on 81489690, #91). Only the latest request for a path commits.
    const fetchGen = React.useRef(new Map<string, number>());
    const genCounter = React.useRef(0);
    // Session fence: the caches are keyed by path, and a mounted view whose
    // sessionId changes keeps a pending request from the OLD session whose
    // result would commit under the new one (Astra on ba243ffb). Retire
    // everything when the session changes.
    const sessionRef = React.useRef(sessionId);
    if (sessionRef.current !== sessionId) {
        sessionRef.current = sessionId;
        fetchedSignatures.current.clear();
        inFlight.current.clear();
        fetchGen.current.clear();
    }

    const fileSignature = (f: GitFileStatus) =>
        `${f.status}|${f.isStaged ? 1 : 0}|${f.linesAdded}|${f.linesRemoved}`;

    React.useEffect(() => {
        if (files.length === 0) {
            // Drop everything; nothing to fetch.
            if (resultsMap.size > 0) setResultsMap(new Map());
            fetchedSignatures.current.clear();
            inFlight.current.clear();
            fetchGen.current.clear(); // outstanding requests lose ownership
            setHasLoadedOnce(true);
            return;
        }

        const session = storage.getState().sessions[sessionId];
        const sessionPath = session?.metadata?.path ?? null;

        // Reconcile keyed cache: drop files no longer present.
        const nextKeys = new Set(files.map((f) => f.fullPath));
        let mapChanged = false;
        const reconciled = new Map(resultsMap);
        // Include paths that are only in flight (no result yet): a removed
        // pending path kept its inFlight entry and generation, so re-adding it
        // started nothing and the pre-removal result committed (Astra on
        // bfcec9fd, #91). Retiring the generation makes that completion a no-op.
        const known = new Set<string>([...reconciled.keys(), ...inFlight.current, ...fetchedSignatures.current.keys(), ...fetchGen.current.keys()]);
        for (const key of known) {
            if (!nextKeys.has(key)) {
                if (reconciled.delete(key)) mapChanged = true;
                fetchedSignatures.current.delete(key);
                inFlight.current.delete(key);
                fetchGen.current.delete(key);
            }
        }
        if (mapChanged) setResultsMap(reconciled);

        // Identify which files need a (re-)fetch.
        const toFetch = files.filter((f) => {
            if (inFlight.current.has(f.fullPath)) return false;
            const prev = fetchedSignatures.current.get(f.fullPath);
            return prev !== fileSignature(f);
        });

        if (toFetch.length === 0) {
            if (!hasLoadedOnce) setHasLoadedOnce(true);
            return;
        }

        // Per-path fetches with ownership by signature. No batch-level cancel:
        // a batch flag either stranded paths (never refetched) or, as a wakeup,
        // cancelled unrelated in-flight work and looped (Astra on e4ee4754,
        // #91). Each completion checks the CURRENT signature of its path: same →
        // commit; changed → fetch the current version; gone → drop.
        const fetchDiffFor = async (file: GitFileStatus): Promise<void> => {
            const path = file.fullPath;
            const sig = fileSignature(file);
            inFlight.current.add(path);
            const myGen = ++genCounter.current;
            fetchGen.current.set(path, myGen);
            const result: FileDiffResult = await (async (): Promise<FileDiffResult> => {
            if (!sessionPath) {
                return { file, content: null, error: 'No session path' };
            }
            const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
            const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;
            if (!gitDiffPath || !resolved) {
                return { file, content: null, error: 'File is outside the session root.' };
            }

            try {
                // Images: show the actual picture (JoyImage fetches the
                // bytes on mount). Other binaries: placeholder, no read.
                if (isImagePath(file.fullPath)) {
                    return { file, content: { kind: 'image' as const, path: resolved.absolutePath }, error: null };
                }
                if (isBinaryPath(file.fullPath)) {
                    return { file, content: { kind: 'binary' as const }, error: null };
                }
                if (file.status === 'untracked') {
                    // Use the native sessionReadFile RPC instead of `cat`
                    // — `cat` doesn't behave the same on Windows
                    // (PowerShell aliases it to Get-Content which
                    // doesn't accept `--`), and shelling out for a
                    // plain read is slower anyway.
                    const res = await sessionReadFile(sessionId, resolved.absolutePath);
                    if (!res.success) {
                        return { file, content: null, error: res.error || 'Failed to read file' };
                    }
                    let contents: string;
                    try {
                        const binary = atob(res.content ?? '');
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                        contents = new TextDecoder().decode(bytes);
                    } catch {
                        return { file, content: null, error: 'Failed to decode file' };
                    }
                    return { file, content: { kind: 'newFile', contents }, error: null };
                }

                // Working tree vs HEAD through the daemon's git route: no
                // shell, so the path is never interpolated (#5, #92).
                const res = await sessionGitDiff(sessionId, { path: gitDiffPath, head: true });
                if (!res.success) {
                    return { file, content: null, error: res.error || 'Failed to fetch diff' };
                }
                return { file, content: { kind: 'patch', patch: res.diff }, error: null };
            } catch (err) {
                return { file, content: null, error: err instanceof Error ? err.message : 'Failed to fetch diff' };
            }
            })();
            if (sessionRef.current !== sessionId || fetchGen.current.get(path) !== myGen) return; // a newer request or another session owns this path
            inFlight.current.delete(path);
            const current = filesRef.current.find((f) => f.fullPath === path);
            if (!current) return; // removed while fetching
            if (fileSignature(current) !== sig) { void fetchDiffFor(current); return; } // changed while fetching
            fetchedSignatures.current.set(path, sig);
            setResultsMap((prev) => { const next = new Map(prev); next.set(path, result); return next; });
            setHasLoadedOnce(true);
        };
        for (const file of toFetch) void fetchDiffFor(file);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId, files]);

    // Render in deterministic file order (same sort as `files`).
    const results = React.useMemo<FileDiffResult[]>(() => {
        const out: FileDiffResult[] = [];
        for (const f of files) {
            const r = resultsMap.get(f.fullPath);
            if (r) out.push(r);
        }
        return out;
    }, [files, resultsMap]);

    // Initial-mount spinner: only show until results have ever been populated.
    const loading = !hasLoadedOnce && results.length === 0 && files.length > 0;

    // Whenever the file list changes (new file silently appears, an existing
    // file disappears, a sort order shifts), all cached Y offsets are
    // potentially stale: insertions push every section below them downward.
    // Drop the cache so the scroll-to-file effect waits for fresh onLayout
    // values rather than scrolling to a position the file no longer occupies.
    React.useEffect(() => {
        fileOffsets.current.clear();
    }, [results]);

    // Scroll to the target file after content renders.
    //
    // Two race conditions to defeat:
    //   1. Initial mount — diffs are still fetching, sections aren't laid out yet,
    //      so the offset map is empty.
    //   2. Re-renders triggered by back / forward navigation — the prop changes
    //      while sections are already mounted; we want the scroll to happen on
    //      the next frame, not after a fixed delay.
    //
    // Strategy: try on the next animation frame; if the offset isn't recorded
    // yet, retry up to a few times.
    React.useEffect(() => {
        if (loading || !scrollToFile) return;
        let cancelled = false;
        let rafId = 0;
        let attempt = 0;
        const tryScroll = () => {
            if (cancelled) return;
            const offset = fileOffsets.current.get(scrollToFile);
            if (offset !== undefined && scrollRef.current) {
                scrollRef.current.scrollTo({ y: offset, animated: true });
                return;
            }
            if (attempt++ < 8) {
                rafId = requestAnimationFrame(tryScroll);
            }
        };
        rafId = requestAnimationFrame(tryScroll);
        return () => {
            cancelled = true;
            cancelAnimationFrame(rafId);
        };
    }, [scrollToFile, loading]);

    // Publish header right-slot controls (file count + diff style toggle) into the chat header.
    React.useEffect(() => {
        onHeaderRightSlotChange(
            <DiffHeaderRight
                fileCount={files.length}
                diffStyle={diffStyle}
                onDiffStyleChange={setDiffStyle}
            />
        );
        return () => onHeaderRightSlotChange(null);
    }, [files.length, diffStyle, setDiffStyle, onHeaderRightSlotChange]);

    if (files.length === 0 && !loading) {
        return (
            <View style={[styles.outer, { backgroundColor: theme.colors.surface }]}>
                <View style={styles.centered}>
                    <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.noChanges')}
                    </Text>
                </View>
            </View>
        );
    }

    return (
        <View style={[styles.outer, { backgroundColor: theme.colors.surface }]}>
            {loading ? (
                <View style={styles.centered}>
                    <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                </View>
            ) : (
                <ScrollView
                    ref={scrollRef}
                    style={{ flex: 1 }}
                    contentContainerStyle={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}
                >
                    {results.map((result) => (
                        <FileDiffSection
                            key={result.file.fullPath}
                            sessionId={sessionId}
                            result={result}
                            diffStyle={diffStyle}
                            isHighlighted={scrollToFile === result.file.fullPath}
                            onLayout={(y) => fileOffsets.current.set(result.file.fullPath, y)}
                        />
                    ))}
                </ScrollView>
            )}
        </View>
    );
});

/** Right-side header controls for the diff overlay: file count + (web-only) Unified | Split toggle. */
const DiffHeaderRight = React.memo(function DiffHeaderRight({
    fileCount,
    diffStyle,
    onDiffStyleChange,
}: {
    fileCount: number;
    diffStyle: 'unified' | 'split';
    onDiffStyleChange: (v: 'unified' | 'split') => void;
}) {
    const { theme } = useUnistyles();
    return (
        <>
            <Text style={[styles.headerRightCount, { color: theme.colors.textSecondary }]}>
                {t('files.changedFiles', { count: fileCount })}
            </Text>
            {Platform.OS === 'web' && (
                <DiffStyleToggle value={diffStyle} onChange={onDiffStyleChange} />
            )}
        </>
    );
});

/** Single file section: header + pre-loaded diff content */
const FileDiffSection = React.memo(function FileDiffSection({
    sessionId,
    result,
    diffStyle,
    isHighlighted,
    onLayout,
}: {
    sessionId: string;
    result: FileDiffResult;
    diffStyle: 'unified' | 'split';
    isHighlighted: boolean;
    onLayout: (y: number) => void;
}) {
    const { theme } = useUnistyles();
    const { file, content, error } = result;
    const [collapsed, setCollapsed] = React.useState(false);

    const fileName = file.fullPath.split('/').pop() || file.fullPath;
    const isBinary = content?.kind === 'binary';
    const isImage = content?.kind === 'image';
    const isEmpty =
        content === null || content.kind === 'binary' || content.kind === 'image' ? false :
        content.kind === 'patch' ? content.patch.trim() === '' :
        content.contents === '';

    const stats = React.useMemo(() => {
        if (!content || content.kind === 'binary' || content.kind === 'image') return null;
        if (content.kind === 'patch') return getPatchDiffStats(content.patch);
        const lineCount = content.contents === '' ? 0 : content.contents.split('\n').length;
        return { additions: lineCount, deletions: 0 };
    }, [content]);

    return (
        <View
            style={[
                styles.fileSection,
                { borderBottomColor: theme.colors.divider },
                isHighlighted && { backgroundColor: theme.colors.surfaceHigh },
            ]}
            onLayout={(e) => onLayout(e.nativeEvent.layout.y)}
        >
            {/* File header */}
            <Pressable
                style={[styles.fileHeader, { backgroundColor: theme.colors.surfaceHigh, borderBottomColor: theme.colors.divider }]}
                onPress={() => setCollapsed((c) => !c)}
            >
                <Ionicons
                    name={collapsed ? 'chevron-forward' : 'chevron-down'}
                    size={14}
                    color={theme.colors.textSecondary}
                />
                <FileIcon fileName={fileName} size={18} />
                <Text
                    numberOfLines={1}
                    ellipsizeMode="middle"
                    style={[styles.headerPath, { color: theme.colors.textSecondary }]}
                >
                    {file.fullPath}
                </Text>
                {file.status === 'deleted' && (
                    <Text style={[styles.statusBadge, { color: '#FF3B30' }]}>deleted</Text>
                )}
                {file.status === 'untracked' && (
                    <Text style={[styles.statusBadge, { color: '#34C759' }]}>new</Text>
                )}
                {stats && (stats.additions > 0 || stats.deletions > 0) && (
                    <View style={styles.stats}>
                        {stats.additions > 0 && <Text style={styles.added}>+{stats.additions}</Text>}
                        {stats.deletions > 0 && <Text style={styles.removed}>-{stats.deletions}</Text>}
                    </View>
                )}
            </Pressable>

            {/* Diff content */}
            {!collapsed && (
                error ? (
                    <View style={styles.sectionMessage}>
                        <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{error}</Text>
                    </View>
                ) : isImage && content?.kind === 'image' ? (
                    <View style={{ padding: 12 }}>
                        <JoyImage sessionId={sessionId} src={content.path} width={null} height={null} alt={fileName} />
                    </View>
                ) : isBinary ? (
                    <View style={styles.sectionMessage}>
                        <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t('files.binaryNoDiff')}</Text>
                    </View>
                ) : !content || isEmpty ? (
                    <View style={styles.sectionMessage}>
                        <Text style={{ color: theme.colors.textSecondary, ...Typography.default() }}>{t('files.noChanges')}</Text>
                    </View>
                ) : content.kind === 'patch' ? (
                    <PierreDiffView
                        key={diffStyle}
                        patch={content.patch}
                        diffStyle={diffStyle}
                        disableFileHeader
                    />
                ) : (
                    <PierreDiffView
                        key={diffStyle}
                        oldFile={{ name: fileName, contents: '' }}
                        newFile={{ name: fileName, contents: content.contents }}
                        diffStyle={diffStyle}
                        disableFileHeader
                    />
                )
            )}
        </View>
    );
});

const DiffStyleToggle = React.memo<{ value: 'unified' | 'split'; onChange: (v: 'unified' | 'split') => void }>(({ value, onChange }) => {
    const { theme } = useUnistyles();
    const buttonStyle = (active: boolean) => ({
        paddingHorizontal: 10,
        paddingVertical: 4,
        borderRadius: 6,
        backgroundColor: active ? theme.colors.surface : 'transparent',
    });
    const textStyle = (active: boolean) => ({
        fontSize: 12,
        ...Typography.default(active ? 'semiBold' : undefined),
        color: active ? theme.colors.text : theme.colors.textSecondary,
    });
    return (
        <View style={[toggleStyles.container, { backgroundColor: theme.colors.groupped.background, borderColor: theme.colors.divider }]}>
            <Pressable onPress={() => onChange('unified')} style={buttonStyle(value === 'unified')}>
                <Text style={textStyle(value === 'unified')}>Unified</Text>
            </Pressable>
            <Pressable onPress={() => onChange('split')} style={buttonStyle(value === 'split')}>
                <Text style={textStyle(value === 'split')}>Split</Text>
            </Pressable>
        </View>
    );
});

const toggleStyles = StyleSheet.create({
    container: {
        flexDirection: 'row',
        gap: 2,
        padding: 2,
        borderRadius: 8,
        borderWidth: StyleSheet.hairlineWidth,
    },
});

const styles = StyleSheet.create({
    outer: {
        flex: 1,
    },
    headerRightCount: {
        fontSize: 13,
        ...Typography.default(),
    },
    centered: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        padding: 20,
    },
    fileSection: {
        borderBottomWidth: 1,
    },
    fileHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        paddingHorizontal: 16,
        paddingVertical: 10,
        borderBottomWidth: 1,
    },
    headerPath: {
        flex: 1,
        fontSize: 13,
        ...Typography.mono(),
    },
    statusBadge: {
        fontSize: 11,
        ...Typography.mono(),
        fontWeight: '600',
    },
    stats: {
        flexDirection: 'row',
        gap: 6,
    },
    added: {
        fontSize: 12,
        color: '#34C759',
        ...Typography.mono(),
    },
    removed: {
        fontSize: 12,
        color: '#FF3B30',
        ...Typography.mono(),
    },
    sectionMessage: {
        paddingVertical: 24,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
