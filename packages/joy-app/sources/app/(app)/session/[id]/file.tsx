import * as React from 'react';
import { decodePathParam } from '@/utils/pathParam';
import { View, ScrollView, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { isDemoSession } from '@/sync/demoSession';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { sessionDeleteFile } from '@/sync/ops';
import { storage, useSession, useLocalSettingMutable } from '@/sync/storage';
import { resources } from '@/sync/resource';
import { fileContentsSpec, gitDiffSpec, type FileContents } from '@/sync/fileContents';
import { useResource } from '@/hooks/useResource';
import { pickDownloadPayload } from '@/utils/fileDownloadSource';
import { isBinaryPath } from '@/utils/binaryFile';
import Ionicons from '@expo/vector-icons/Ionicons';
import { copyToClipboard } from '@/utils/clipboard';
import { guarded } from '@/utils/guardAsync';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { FileIcon } from '@/components/FileIcon';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';
import { FileRenderedView, fileRenderKind, isRasterImagePath } from '@/components/FileContentRender';
import { downloadFile } from '@/utils/downloadFile';

type DisplayMode = 'file' | 'diff' | 'rendered';

/** A session with no backend to read from (preview/demo, unknown session)
 *  shows an empty text file rather than an error. */
const NO_BACKEND_FILE: FileContents = { base64: '', content: '', isBinary: false };

// Diff display component
const DiffDisplay: React.FC<{ diffContent: string; fontSize?: number }> = ({ diffContent, fontSize = 14 }) => {
    const { theme } = useUnistyles();
    const lines = diffContent.split('\n');

    return (
        <View>
            {lines.map((line, index) => {
                const baseStyle = { ...Typography.mono(), fontSize, lineHeight: Math.round(fontSize * 1.43) };
                let lineStyle: any = baseStyle;
                let backgroundColor = 'transparent';

                if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.addedText };
                    backgroundColor = theme.colors.diff.addedBg;
                } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.removedText };
                    backgroundColor = theme.colors.diff.removedBg;
                } else if (line.startsWith('@@')) {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.hunkHeaderText, fontWeight: '600' };
                    backgroundColor = theme.colors.diff.hunkHeaderBg;
                } else if (line.startsWith('+++') || line.startsWith('---')) {
                    lineStyle = { ...baseStyle, color: theme.colors.text, fontWeight: '600' };
                } else {
                    lineStyle = { ...baseStyle, color: theme.colors.diff.contextText };
                }

                return (
                    <View
                        key={index}
                        style={{
                            backgroundColor,
                            paddingHorizontal: 8,
                            paddingVertical: 1,
                            borderLeftWidth: line.startsWith('+') && !line.startsWith('+++') ? 3 :
                                           line.startsWith('-') && !line.startsWith('---') ? 3 : 0,
                            borderLeftColor: line.startsWith('+') && !line.startsWith('+++') ? theme.colors.diff.addedBorder : theme.colors.diff.removedBorder
                        }}
                    >
                        <Text style={lineStyle} selectable>
                            {line || ' '}
                        </Text>
                    </View>
                );
            })}
        </View>
    );
};

export default React.memo(function FileScreen() {
    const { theme } = useUnistyles();
    const { id: sessionId } = useLocalSearchParams<{ id: string }>();
    const searchParams = useLocalSearchParams();
    const encodedPath = searchParams.path as string;
    const lineParam = searchParams.line as string | undefined;
    const columnParam = searchParams.column as string | undefined;
    const requestedLine = lineParam ? Number.parseInt(lineParam, 10) : null;
    const requestedColumn = columnParam ? Number.parseInt(columnParam, 10) : null;
    // Reactive: a cold-opened deep link renders before sessions hydrate. With
    // a one-shot getState() read the "unknown session → empty file" branch
    // was final; subscribing lets the read start once the session arrives (#162).
    const session = useSession(sessionId!);
    const sessionsReady = storage((s) => s.isDataReady);
    const hasSession = !!session;
    const sessionPath = session?.metadata?.path ?? null;
    let rawPath = '';

    // Decode base64 path with error handling
    try {
        rawPath = encodedPath ? decodePathParam(encodedPath) : '';
    } catch (error) {
        console.error('Failed to decode file path:', error);
        rawPath = encodedPath || '';
    }
    const resolvedPath = resolveSessionFilePath(rawPath, sessionPath);
    const filePath = resolvedPath?.absolutePath ?? rawPath;
    const gitDiffPath = resolvedPath?.withinSessionRoot ? resolvedPath.relativePath : null;
    const renderKind = fileRenderKind(filePath);
    const isRaster = isRasterImagePath(filePath);
    // A known non-image binary is never read: the screen only shows the
    // notice, and Download fetches its bytes on demand. Raster images are
    // binary but renderable, so they are read (as base64) like text.
    const knownBinary = isBinaryPath(filePath) && !isRaster;

    // Sessions still hydrating: stay in the loading state until the session
    // record lands (#162). Preview/demo or unknown session (no real session
    // record, hence no encryption): there is no backend to read from, so no
    // RPC is made instead of throwing "Session encryption not found".
    const isDemo = !!sessionId && isDemoSession(sessionId);
    const hydrating = !!sessionId && !isDemo && !hasSession && !sessionsReady;
    const canRead = !!sessionId && !isDemo && hasSession;

    // The file and its diff are RESOURCES (sync/fileContents) shared with the
    // prefetcher, the file panel and the changes view: rendered straight from
    // the cache (instant on revisit, and a save made elsewhere shows here as
    // soon as it enters the cache), revalidated on open and on re-focus. Only
    // user intent — the chosen tab, font, wrap — lives in this component.
    const fileSpec = React.useMemo(() => (sessionId ? fileContentsSpec(sessionId, filePath) : null), [sessionId, filePath]);
    const diffSpec = React.useMemo(
        () => (sessionId && gitDiffPath && gitDiffPath !== '.' ? gitDiffSpec(sessionId, gitDiffPath) : null),
        [sessionId, gitDiffPath],
    );
    const fileKey = fileSpec?.key ?? '';
    const file = useResource<FileContents>(fileSpec, { enabled: canRead && !knownBinary });
    // The diff is best-effort: a failed diff read is no diff.
    const diff = useResource<string>(diffSpec, { enabled: canRead && !!sessionPath && !isBinaryPath(filePath) });

    const data: FileContents | undefined = canRead ? file.data : (hydrating ? undefined : NO_BACKEND_FILE);
    const isBinary = knownBinary || (data?.isBinary ?? false);
    // Raster images arrive as base64 (never decoded to text) — rendered-only.
    // A zero-byte image has nothing to render: binary notice, not an error (#87).
    const imageBase64 = isRaster && data?.base64 ? data.base64 : null;
    const fileText = data && !isBinary ? (data.content ?? '') : null;
    // An authoritative empty diff (the daemon says the file is unchanged)
    // is no diff: the Diff tab and its content go away.
    const diffContent = diff.data && diff.data.trim() ? diff.data : null;
    const isLoading = hydrating || (canRead && !knownBinary && !file.hasData && !file.error && !file.unavailable);
    // A read failure with nothing cached is an error state; with a last good
    // value on screen it is a missed revalidation, surfaced inline below.
    const fatalError = canRead && !knownBinary && !file.hasData ? (file.error ?? file.unavailable) : null;
    const refreshFailed = (file.hasData && !!file.error) || (diff.hasData && !!diff.error);
    const retryRefresh = React.useCallback(() => {
        if (file.error) void file.refresh();
        if (diff.error) void diff.refresh();
    }, [file, diff]);

    // The tab is user intent, kept per file: an explicit choice sticks while
    // it can still be shown (the Diff tab disappears with the diff, an image
    // has no source view); until the user picks, the default follows the data.
    // Renderable text (md/html/csv/tsv) opens in SOURCE (rendering is the
    // explicit opt-in); images open rendered (no text form); everything else
    // keeps the diff-first behavior.
    const [chosenMode, setChosenMode] = React.useState<{ key: string; mode: DisplayMode } | null>(null);
    const canRender = !!imageBase64 || (!!renderKind && renderKind !== 'image');
    const modeAvailable = (mode: DisplayMode): boolean =>
        mode === 'diff' ? !!diffContent : mode === 'rendered' ? canRender : !imageBase64;
    const defaultMode: DisplayMode = requestedLine !== null && requestedLine > 0 ? 'file'
        : imageBase64 ? 'rendered'
        : renderKind ? 'file'
        : diffContent ? 'diff'
        : 'file';
    const displayMode: DisplayMode = chosenMode && chosenMode.key === fileKey && modeAvailable(chosenMode.mode)
        ? chosenMode.mode
        : defaultMode;
    const setDisplayMode = React.useCallback((mode: DisplayMode) => setChosenMode({ key: fileKey, mode }), [fileKey]);

    const [fontSize, setFontSize] = useLocalSettingMutable('fileViewerFontSize');
    const [wrap, setWrap] = useLocalSettingMutable('fileViewerWrap');
    const bumpFont = (delta: number) => setFontSize(Math.max(9, Math.min(28, (fontSize ?? 14) + delta)));
    // Copy the whole visible content (file text or raw diff). Per-line
    // selection exists too, but iOS long-press selection inside nested
    // scroll views is unreliable — the button is the dependable path.
    const [copied, setCopied] = React.useState(false);
    const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
    const copyContent = React.useCallback(guarded(async (text: string | null | undefined) => {
        if (!text) return;
        if (!(await copyToClipboard(text))) return;
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    }), []);
    // Long-press → the dedicated text-selection screen (native text view with
    // real drag-handle PARTIAL selection). RN's inline `selectable` can't do
    // this reliably on iOS: per-line Texts cap selection at one line and
    // nested highlight spans break partial drags — same reason markdown
    // messages long-press into this screen.
    const router = useRouter();
    const openTextSelection = React.useCallback((text: string | null | undefined) => {
        if (!text) return;
        try {
            const textId = storeTempText(text);
            router.push(`/text-selection?textId=${textId}`);
        } catch {
            Modal.alert(t('common.error'), t('errors.operationFailed'));
        }
    }, [router]);
    const [deleting, setDeleting] = React.useState(false);

    // Delete the file on the machine. Irreversible (the daemon unlinks it — no
    // trash), so it always confirms first and names the file in the prompt.
    // On success we leave the viewer: the screen it returns to re-lists the
    // directory, and staying would show contents of something that's gone.
    const handleDelete = React.useCallback(async () => {
        if (deleting) return;
        // Local derivation: the shared `fileName` const is declared further
        // down the component, past this callback.
        const name = filePath.split('/').pop() || filePath;
        const confirmed = await Modal.confirm(
            'Delete file?',
            `${name} will be permanently deleted from this machine. This cannot be undone.`,
            { confirmText: 'Delete', destructive: true },
        );
        if (!confirmed) return;
        setDeleting(true);
        try {
            const res = await sessionDeleteFile(sessionId, filePath);
            if (!res.success) {
                Modal.alert(t('common.error'), res.error || t('errors.operationFailed'));
                return;
            }
            router.back();
        } finally {
            setDeleting(false);
        }
    }, [deleting, filePath, sessionId, router]);
    const scrollViewRef = React.useRef<ScrollView | null>(null);

    // Determine file language from extension
    const getFileLanguage = React.useCallback((path: string): string | null => {
        const ext = path.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'js':
            case 'jsx':
                return 'javascript';
            case 'ts':
            case 'tsx':
                return 'typescript';
            case 'py':
                return 'python';
            case 'html':
            case 'htm':
                return 'html';
            case 'css':
                return 'css';
            case 'json':
                return 'json';
            case 'md':
                return 'markdown';
            case 'xml':
                return 'xml';
            case 'yaml':
            case 'yml':
                return 'yaml';
            case 'sh':
            case 'bash':
                return 'bash';
            case 'sql':
                return 'sql';
            case 'go':
                return 'go';
            case 'rust':
            case 'rs':
                return 'rust';
            case 'java':
                return 'java';
            case 'c':
                return 'c';
            case 'cpp':
            case 'cc':
            case 'cxx':
                return 'cpp';
            case 'php':
                return 'php';
            case 'rb':
                return 'ruby';
            case 'swift':
                return 'swift';
            case 'kt':
                return 'kotlin';
            default:
                return null;
        }
    }, []);

    React.useEffect(() => {
        if (!fileText || displayMode !== 'file' || requestedLine === null || requestedLine <= 0) {
            return;
        }
        const offset = Math.max(0, ((requestedLine - 1) * 20) - 40);
        requestAnimationFrame(() => {
            scrollViewRef.current?.scrollTo({ y: offset, animated: false });
        });
    }, [displayMode, fileText, requestedLine]);

    const fileName = filePath.split('/').pop() || filePath;
    // Download what is ON DISK: the resource's bytes as received. Text and
    // images are already in memory; a binary that is not an image (pdf,
    // xlsx, zip…) was never fetched — the viewer only shows the "binary file"
    // notice — so its bytes are read now, through the same resource.
    // Text downloads use the ORIGINAL bytes too: re-encoding the displayed
    // UTF-8 decode rewrote Latin-1 bytes as U+FFFD and dropped BOMs (#164).
    const downloadCurrent = React.useCallback(async () => {
        const payload = pickDownloadPayload({
            imageBase64,
            rawBase64: canRead ? (data?.base64 ?? null) : null,
            isBinary,
            displayText: fileText,
            canRefetch: canRead && !!fileSpec,
        });
        if (payload.kind === 'base64') return downloadFile(fileName, { base64: payload.base64 });
        if (payload.kind === 'refetch') {
            const entry = await resources.ensure(fileSpec!, { staleTime: Infinity });
            if (!entry.data) throw new Error(entry.error || entry.unavailable || 'read failed');
            return downloadFile(fileName, { base64: entry.data.base64 }); // an empty file downloads as an empty file
        }
        return downloadFile(fileName, { utf8: payload.text });
    }, [imageBase64, canRead, data, isBinary, fileText, fileSpec, fileName]);
    const language = getFileLanguage(filePath);

    if (isLoading) {
        return (
            <View style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
                justifyContent: 'center',
                alignItems: 'center'
            }}>
                <ActivityIndicator size="small" color={theme.colors.textSecondary} />
                <Text style={{
                    marginTop: 16,
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    ...Typography.default()
                }}>
                    {t('files.loadingFile', { fileName })}
                </Text>
            </View>
        );
    }

    if (fatalError) {
        return (
            <View style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20
            }}>
                <Text style={{
                    fontSize: 18,
                    fontWeight: 'bold',
                    color: theme.colors.textDestructive,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('common.error')}
                </Text>
                <Text style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default()
                }}>
                    {fatalError}
                </Text>
                <Pressable
                    onPress={() => { void file.refresh(); }}
                    hitSlop={8}
                    style={{ marginTop: 20, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.colors.button.primary.background }}
                    accessibilityRole="button"
                >
                    <Text style={{ fontSize: 15, color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                        {t('common.retry')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    if (isBinary && !imageBase64) {
        return (
            <View style={{
                flex: 1,
                backgroundColor: theme.colors.surface,
                justifyContent: 'center',
                alignItems: 'center',
                padding: 20
            }}>
                <Text style={{
                    fontSize: 18,
                    fontWeight: 'bold',
                    color: theme.colors.textSecondary,
                    marginBottom: 8,
                    ...Typography.default('semiBold')
                }}>
                    {t('files.binaryFile')}
                </Text>
                <Text style={{
                    fontSize: 16,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    ...Typography.default()
                }}>
                    {t('files.cannotDisplayBinary')}
                </Text>
                <Text style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    textAlign: 'center',
                    marginTop: 8,
                    ...Typography.default()
                }}>
                    {fileName}
                </Text>
                <Pressable
                    onPress={() => { void downloadCurrent().catch(() => Modal.alert(t('common.error'), t('errors.operationFailed'))); }}
                    hitSlop={8}
                    style={{ marginTop: 20, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 10, backgroundColor: theme.colors.button.primary.background }}
                    accessibilityRole="button"
                >
                    <Text style={{ fontSize: 15, color: theme.colors.button.primary.tint, ...Typography.default('semiBold') }}>
                        {t('files.download')}
                    </Text>
                </Pressable>
            </View>
        );
    }

    return (
        <View style={[styles.container, { backgroundColor: theme.colors.surface }]}>

            {/* File path header */}
            <View style={{
                padding: 16,
                borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                borderBottomColor: theme.colors.divider,
                backgroundColor: theme.colors.surfaceHigh,
                flexDirection: 'row',
                alignItems: 'center'
            }}>
                <FileIcon fileName={fileName} size={20} />
                <Text style={{
                    fontSize: 14,
                    color: theme.colors.textSecondary,
                    marginLeft: 8,
                    flex: 1,
                    ...Typography.mono()
                }}>
                    {requestedLine !== null && requestedLine > 0
                        ? `${filePath}:${requestedLine}${requestedColumn !== null && requestedColumn > 0 ? `:${requestedColumn}` : ''}`
                        : filePath}
                </Text>
                {/* Viewer controls: font zoom + word-wrap toggle (persisted). */}
                <Pressable onPress={() => bumpFont(-1)} hitSlop={8} style={styles.ctrlBtn} accessibilityRole="button" accessibilityLabel="Decrease font size">
                    <Text style={[styles.ctrlText, { color: theme.colors.textSecondary }]}>A−</Text>
                </Pressable>
                <Pressable onPress={() => bumpFont(1)} hitSlop={8} style={styles.ctrlBtn} accessibilityRole="button" accessibilityLabel="Increase font size">
                    <Text style={[styles.ctrlText, { color: theme.colors.textSecondary, fontSize: 18 }]}>A+</Text>
                </Pressable>
                <Pressable onPress={() => setWrap(!wrap)} hitSlop={8} style={styles.ctrlBtn} accessibilityRole="switch" accessibilityState={{ checked: wrap }} accessibilityLabel="Toggle word wrap">
                    <Ionicons name={wrap ? 'return-down-forward' : 'arrow-forward'} size={18} color={wrap ? theme.colors.textLink : theme.colors.textSecondary} />
                </Pressable>
                <Pressable
                    onPress={() => copyContent(displayMode === 'diff' && diffContent ? diffContent : fileText)}
                    onLongPress={() => openTextSelection(displayMode === 'diff' && diffContent ? diffContent : fileText)}
                    hitSlop={8}
                    style={styles.ctrlBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Copy contents (long-press to select text)"
                >
                    <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={17} color={copied ? theme.colors.textLink : theme.colors.textSecondary} />
                </Pressable>
                <Pressable
                    onPress={() => {
                        void downloadCurrent()
                            .catch(() => Modal.alert(t('common.error'), t('errors.operationFailed')));
                    }}
                    hitSlop={8}
                    style={styles.ctrlBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Download file"
                >
                    <Ionicons name="download-outline" size={17} color={theme.colors.textSecondary} />
                </Pressable>
                <Pressable
                    onPress={() => { void handleDelete(); }}
                    disabled={deleting}
                    hitSlop={8}
                    style={styles.ctrlBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Delete file"
                >
                    <Ionicons
                        name="trash-outline"
                        size={17}
                        color={deleting ? theme.colors.textSecondary : theme.colors.status.error}
                    />
                </Pressable>
            </View>

            {/* A revalidation that failed keeps the last loaded version on
                screen and says so, instead of hiding it behind an error. */}
            {refreshFailed && (
                <View style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 16,
                    paddingVertical: 8,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surfaceHigh,
                }}>
                    <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textSecondary} />
                    <Text style={{ flex: 1, marginLeft: 8, fontSize: 13, color: theme.colors.textSecondary, ...Typography.default() }}>
                        {t('files.refreshFailed')}
                    </Text>
                    <Pressable onPress={retryRefresh} hitSlop={8} accessibilityRole="button">
                        <Text style={{ fontSize: 13, color: theme.colors.textLink, ...Typography.default('semiBold') }}>
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </View>
            )}

            {/* Mode chips: Diff (when a diff exists) / Source / Rendered (when
                the type is renderable). Images render-only, so no chips there. */}
            {(diffContent || (renderKind && renderKind !== 'image')) && !imageBase64 && (
                <View style={{
                    flexDirection: 'row',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface
                }}>
                    {diffContent && (
                        <Pressable
                            onPress={() => setDisplayMode('diff')}
                            style={{
                                paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, marginRight: 8,
                                backgroundColor: displayMode === 'diff' ? theme.colors.textLink : theme.colors.input.background,
                            }}
                        >
                            <Text style={{ fontSize: 14, fontWeight: '600', color: displayMode === 'diff' ? 'white' : theme.colors.textSecondary, ...Typography.default() }}>
                                {t('files.diff')}
                            </Text>
                        </Pressable>
                    )}
                    <Pressable
                        onPress={() => setDisplayMode('file')}
                        style={{
                            paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, marginRight: 8,
                            backgroundColor: displayMode === 'file' ? theme.colors.textLink : theme.colors.input.background,
                        }}
                    >
                        <Text style={{ fontSize: 14, fontWeight: '600', color: displayMode === 'file' ? 'white' : theme.colors.textSecondary, ...Typography.default() }}>
                            {renderKind ? t('files.source') : t('files.file')}
                        </Text>
                    </Pressable>
                    {renderKind && renderKind !== 'image' && (
                        <Pressable
                            onPress={() => setDisplayMode('rendered')}
                            style={{
                                paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
                                backgroundColor: displayMode === 'rendered' ? theme.colors.textLink : theme.colors.input.background,
                            }}
                        >
                            <Text style={{ fontSize: 14, fontWeight: '600', color: displayMode === 'rendered' ? 'white' : theme.colors.textSecondary, ...Typography.default() }}>
                                {t('files.rendered')}
                            </Text>
                        </Pressable>
                    )}
                </View>
            )}

            {/* Content display */}
            {displayMode === 'rendered' ? (
                <View style={{ flex: 1 }}>
                    <FileRenderedView filePath={filePath} content={fileText ?? undefined} base64={imageBase64} />
                </View>
            ) : (
            <ScrollView
                ref={scrollViewRef}
                style={{ flex: 1 }}
                contentContainerStyle={{ padding: 16, maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}
                showsVerticalScrollIndicator={true}
            >
                {displayMode === 'diff' && diffContent ? (
                    wrap ? (
                        <DiffDisplay diffContent={diffContent} fontSize={fontSize ?? 14} />
                    ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                            <DiffDisplay diffContent={diffContent} fontSize={fontSize ?? 14} />
                        </ScrollView>
                    )
                ) : displayMode === 'file' && fileText ? (
                    wrap ? (
                        <SimpleSyntaxHighlighter code={fileText} language={language} selectable={true} fontSize={fontSize ?? 14} wrap={true} />
                    ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                            <SimpleSyntaxHighlighter code={fileText} language={language} selectable={true} fontSize={fontSize ?? 14} wrap={false} />
                        </ScrollView>
                    )
                ) : displayMode === 'file' && fileText === '' ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.fileEmpty')}
                    </Text>
                ) : !diffContent && !fileText ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.noChanges')}
                    </Text>
                ) : null}
            </ScrollView>
            )}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    ctrlBtn: {
        paddingHorizontal: 6,
        paddingVertical: 2,
        marginLeft: 4,
        alignItems: 'center',
        justifyContent: 'center',
    },
    ctrlText: {
        fontSize: 15,
        fontWeight: '600',
    },
    container: {
        // Header (file path + toggle) spans the full screen width;
        // the code/diff body is bounded by layout.maxWidth on the ScrollView's
        // contentContainerStyle so it lines up with the chat / changes views.
        flex: 1,
    }
}));
