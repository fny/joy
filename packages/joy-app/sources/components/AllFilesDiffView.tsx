import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Pressable, Platform } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Text } from '@/components/StyledText';
import { Typography } from '@/constants/Typography';
import { FileIcon } from '@/components/FileIcon';
import { PierreDiffView } from '@/components/diff/PierreDiffView';
import { getPatchDiffStats } from '@/components/diff/calculateDiff';
import { isBinaryPath, isImagePath } from '@/utils/binaryFile';
import { JoyImage } from '@/components/JoyImage';
import { useSession, useSettingMutable } from '@/sync/storage';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { useGitStatusResource } from '@/sync/gitStatusResource';
import type { GitFileStatus } from '@/sync/gitStatusModel';
import { resources, type ResourceEntry, type ResourceSpec } from '@/sync/resource';
import { fileContentsSpec, gitDiffSpec, type FileContents } from '@/sync/fileContents';
import { useResources } from '@/hooks/useResource';
import { layout } from '@/components/layout';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { t } from '@/text';
import { diffSignature, rowsByPath } from './allFilesDiffSignature';

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

/** What a file's section needs from the daemon — a fetch through ONE of the
 *  two file resources, or nothing (a static section). */
type DiffData = string | FileContents;
type SectionPlan =
    | { kind: 'static'; result: FileDiffResult }
    | { kind: 'patch' | 'newFile'; file: GitFileStatus; spec: ResourceSpec<DiffData> };

function planSection(sessionId: string, sessionPath: string | null, file: GitFileStatus, version: string): SectionPlan {
    const fixed = (content: DiffContent | null, error: string | null): SectionPlan => ({ kind: 'static', result: { file, content, error } });
    // A name that is not valid UTF-8 has no path the daemon accepts: its
    // identity key must never reach git/diff or files/read. Display only.
    if (file.unaddressable) return fixed(null, 'This file name is not valid UTF-8; it cannot be read or diffed.');
    if (!sessionPath) return fixed(null, 'No session path');
    const resolved = resolveSessionFilePath(file.fullPath, sessionPath);
    const gitDiffPath = resolved?.withinSessionRoot ? resolved.relativePath : null;
    if (!gitDiffPath || !resolved) return fixed(null, 'File is outside the session root.');
    // Images: show the actual picture (JoyImage fetches the bytes on mount).
    // Other binaries: placeholder, no read.
    if (isImagePath(file.fullPath)) return fixed({ kind: 'image', path: resolved.absolutePath }, null);
    // git's own verdict first (numstat "-"), then the extension list.
    if (file.binary || isBinaryPath(file.fullPath)) return fixed({ kind: 'binary' }, null);
    if (file.status === 'untracked') {
        // The whole file is the diff. Read through the file resource (the same
        // one the file screen and the prefetcher use) — never `cat`.
        return { kind: 'newFile', file, spec: { ...fileContentsSpec(sessionId, resolved.absolutePath), version, staleTime: Infinity } as ResourceSpec<DiffData> };
    }
    // Working tree vs HEAD through the daemon's git route: no shell, so the
    // path is never interpolated (#5, #92).
    return { kind: 'patch', file, spec: gitDiffSpec(sessionId, gitDiffPath, { head: true }, version) as ResourceSpec<DiffData> };
}

function resultFromEntry(plan: Exclude<SectionPlan, { kind: 'static' }>, entry: ResourceEntry<DiffData> | undefined): FileDiffResult | null {
    if (!entry || !entry.hasData) {
        const error = entry?.error ?? entry?.unavailable ?? null;
        return error ? { file: plan.file, content: null, error } : null;
    }
    if (plan.kind === 'patch') return { file: plan.file, content: { kind: 'patch', patch: entry.data as string }, error: null };
    const f = entry.data as FileContents;
    if (f.isBinary || f.content === null) return { file: plan.file, content: { kind: 'binary' }, error: null };
    return { file: plan.file, content: { kind: 'newFile', contents: f.content }, error: null };
}

/**
 * Renders every changed file's diff in a single ScrollView. Each diff is a
 * RESOURCE keyed by session + path + options and versioned by the file's
 * status signature plus the repository check that produced it: a status
 * change refetches the diff while the previous one stays on screen, an
 * equal answer keeps its reference (no re-render, no scroll jump), and a
 * failed read is retried on the next check or on Retry (#91, #199, #200).
 * Shows a global loading spinner until the first diff arrives to prevent
 * layout jumps.
 */
export const AllFilesDiffView = React.memo(function AllFilesDiffView({
    sessionId,
    scrollToFile,
    onlyFile,
    onHeaderRightSlotChange,
}: AllFilesDiffViewProps) {
    const { theme } = useUnistyles();
    const status = useGitStatusResource(sessionId);
    const gitStatusFiles = status.files;
    const sessionPath = useSession(sessionId)?.metadata?.path ?? null;
    const [diffStyle, setDiffStyle] = useSettingMutable('diffStyle');
    const scrollRef = React.useRef<ScrollView>(null);
    const fileOffsets = React.useRef<Map<string, number>>(new Map());

    // Every status row per identity path (staged + unstaged): the diff's
    // identity must see BOTH portions, not just the first-listed row (#199).
    const statusRowsByPath = React.useMemo(
        () => rowsByPath(gitStatusFiles ? [...gitStatusFiles.stagedFiles, ...gitStatusFiles.unstagedFiles] : []),
        [gitStatusFiles],
    );
    // Repository revision: the time the daemon last answered a status read.
    // git status carries no content hash, so an edit that keeps status and
    // line counts (an untracked file's text, a +1/-1 rewritten as another
    // +1/-1) is invisible to the signature alone; every status check
    // re-validates the diffs instead, and an unchanged diff keeps its
    // reference (#199 residual).
    const revision = status.checkedAt;

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

    const plans = React.useMemo(
        () => files.map((f) => planSection(sessionId, sessionPath, f, diffSignature(statusRowsByPath.get(f.fullPath) ?? [f], revision))),
        [files, sessionId, sessionPath, statusRowsByPath, revision],
    );
    const specs = React.useMemo(
        () => plans.flatMap((p) => (p.kind === 'static' ? [] : [p.spec])),
        [plans],
    );
    const entries = useResources(specs);
    const entryByKey = React.useMemo(() => new Map(entries.map((e) => [e.key, e])), [entries]);

    const retryPath = React.useCallback((path: string) => {
        const plan = plans.find((p) => p.kind !== 'static' && p.file.fullPath === path);
        if (plan && plan.kind !== 'static') void resources.refresh(plan.spec);
    }, [plans]);

    // Render in deterministic file order (same sort as `files`). A section
    // without a result yet (first fetch in flight) is left out, like before.
    const results = React.useMemo<FileDiffResult[]>(() => {
        const out: FileDiffResult[] = [];
        for (const plan of plans) {
            const r = plan.kind === 'static' ? plan.result : resultFromEntry(plan, entryByKey.get(plan.spec.key));
            if (r) out.push(r);
        }
        return out;
    }, [plans, entryByKey]);
    const hasLoadedOnce = results.length > 0 || files.length === 0;

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
                            onRetry={retryPath}
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
    onRetry,
}: {
    sessionId: string;
    result: FileDiffResult;
    diffStyle: 'unified' | 'split';
    isHighlighted: boolean;
    onLayout: (y: number) => void;
    /** Fetch this file's diff again after a failed read (#200). */
    onRetry: (path: string) => void;
}) {
    const { theme } = useUnistyles();
    const { file, content, error } = result;
    const [collapsed, setCollapsed] = React.useState(false);

    const fileName = file.fileName; // display text; file.fullPath stays the identity
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
                    {file.displayPath}
                </Text>
                {file.status === 'deleted' && (
                    <Text style={[styles.statusBadge, { color: '#FF3B30' }]}>deleted</Text>
                )}
                {file.status === 'untracked' && (
                    <Text style={[styles.statusBadge, { color: '#34C759' }]}>new</Text>
                )}
                {file.status === 'conflicted' && (
                    <Text style={[styles.statusBadge, { color: '#FF9500' }]}>{t('files.conflicted')}</Text>
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
                        <Pressable
                            onPress={() => onRetry(file.fullPath)}
                            accessibilityRole="button"
                            style={({ pressed }) => [styles.retryButton, { borderColor: theme.colors.divider, opacity: pressed ? 0.7 : 1 }]}
                        >
                            <Text style={{ color: theme.colors.textLink, fontSize: 13, ...Typography.default('semiBold') }}>{t('common.retry')}</Text>
                        </Pressable>
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
        gap: 12,
    },
    retryButton: {
        paddingHorizontal: 12,
        paddingVertical: 6,
        borderRadius: 6,
        borderWidth: 1,
    },
});
