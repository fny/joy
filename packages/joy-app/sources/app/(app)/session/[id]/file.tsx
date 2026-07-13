import * as React from 'react';
import { View, ScrollView, ActivityIndicator, Platform, Pressable } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { isDemoSession } from '@/sync/demoSession';
import { Text } from '@/components/StyledText';
import { SimpleSyntaxHighlighter } from '@/components/SimpleSyntaxHighlighter';
import { Typography } from '@/constants/Typography';
import { sessionReadFile, sessionBash } from '@/sync/ops';
import { storage, useSessionFileCache, useLocalSettingMutable } from '@/sync/storage';
import { isBinaryPath } from '@/utils/binaryFile';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { storeTempText } from '@/sync/persistence';
import { useRouter } from 'expo-router';
import { Modal } from '@/modal';
import { useUnistyles, StyleSheet } from 'react-native-unistyles';
import { layout } from '@/components/layout';
import { t } from '@/text';
import { FileIcon } from '@/components/FileIcon';
import { resolveSessionFilePath } from '@/utils/sessionFileLinks';

interface FileContent {
    content: string;
    encoding: 'utf8' | 'base64';
    isBinary: boolean;
}

function decodeBase64ToBytes(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

function decodeUtf8Bytes(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes);
}

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
    const session = storage.getState().sessions[sessionId!];
    const sessionPath = session?.metadata?.path ?? null;
    let rawPath = '';

    // Decode base64 path with error handling
    try {
        rawPath = encodedPath ? atob(encodedPath) : '';
    } catch (error) {
        console.error('Failed to decode file path:', error);
        rawPath = encodedPath || '';
    }
    const resolvedPath = resolveSessionFilePath(rawPath, sessionPath);
    const filePath = resolvedPath?.absolutePath ?? rawPath;
    const gitDiffPath = resolvedPath?.withinSessionRoot ? resolvedPath.relativePath : null;

    // Read from Zustand cache for instant rendering on revisit
    const cached = useSessionFileCache(sessionId!, filePath);

    const [fileContent, setFileContent] = React.useState<FileContent | null>(() => {
        if (!cached) return null;
        return { content: cached.content ?? '', encoding: 'utf8', isBinary: cached.isBinary };
    });
    const [diffContent, setDiffContent] = React.useState<string | null>(() => cached?.diff ?? null);
    const [displayMode, setDisplayMode] = React.useState<'file' | 'diff'>('diff');
    const [fontSize, setFontSize] = useLocalSettingMutable('fileViewerFontSize');
    const [wrap, setWrap] = useLocalSettingMutable('fileViewerWrap');
    const bumpFont = (delta: number) => setFontSize(Math.max(9, Math.min(28, (fontSize ?? 14) + delta)));
    // Copy the whole visible content (file text or raw diff). Per-line
    // selection exists too, but iOS long-press selection inside nested
    // scroll views is unreliable — the button is the dependable path.
    const [copied, setCopied] = React.useState(false);
    const copiedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
    const copyContent = React.useCallback((text: string | null | undefined) => {
        if (!text) return;
        void Clipboard.setStringAsync(text);
        setCopied(true);
        if (copiedTimer.current) clearTimeout(copiedTimer.current);
        copiedTimer.current = setTimeout(() => setCopied(false), 1500);
    }, []);
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
    const [isLoading, setIsLoading] = React.useState(!cached);
    const [error, setError] = React.useState<string | null>(null);
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

    // Check if file is likely binary based on extension
    const isBinaryFile = React.useCallback((path: string): boolean => isBinaryPath(path), []);

    // Load file content (fetches in background even if cache exists)
    React.useEffect(() => {
        let isCancelled = false;

        const loadFile = async () => {
            try {
                // Preview/demo or unknown session (no real session record, hence
                // no encryption) — there's no backend to read from, so skip the
                // RPC instead of throwing "Session encryption not found".
                if (!sessionId || isDemoSession(sessionId) || !storage.getState().sessions[sessionId]) {
                    if (!isCancelled) {
                        setFileContent({ content: '', encoding: 'utf8', isBinary: false });
                        setIsLoading(false);
                    }
                    return;
                }

                // Only show loading spinner if no cache
                if (!cached) {
                    setIsLoading(true);
                }
                setError(null);

                if (isBinaryFile(filePath)) {
                    if (!isCancelled) {
                        setFileContent({ content: '', encoding: 'base64', isBinary: true });
                        storage.getState().applyFileCache(sessionId!, filePath, '', null, true);
                        setIsLoading(false);
                    }
                    return;
                }

                let fetchedDiff: string | null = null;

                // Fetch git diff for the file (if in git repo)
                if (sessionPath && sessionId && gitDiffPath && gitDiffPath !== '.') {
                    try {
                        const diffResponse = await sessionBash(sessionId, {
                            command: `git diff --no-ext-diff -- "${gitDiffPath}"`,
                            cwd: sessionPath,
                            timeout: 5000
                        });

                        if (!isCancelled && diffResponse.success && diffResponse.stdout.trim()) {
                            fetchedDiff = diffResponse.stdout;
                            setDiffContent(fetchedDiff);
                        }
                    } catch (diffError) {
                        console.log('Could not fetch git diff:', diffError);
                    }
                }

                const response = await sessionReadFile(sessionId, filePath);

                if (!isCancelled) {
                    if (response.success && response.content) {
                        let rawBytes: Uint8Array;
                        let decodedContent: string;
                        try {
                            rawBytes = decodeBase64ToBytes(response.content);
                            decodedContent = decodeUtf8Bytes(rawBytes);
                        } catch (decodeError) {
                            setFileContent({ content: '', encoding: 'base64', isBinary: true });
                            storage.getState().applyFileCache(sessionId!, filePath, '', fetchedDiff, true);
                            return;
                        }

                        const hasNullBytes = rawBytes.some((byte) => byte === 0);
                        const nonPrintableCount = decodedContent.split('').filter(char => {
                            const code = char.charCodeAt(0);
                            return code < 32 && code !== 9 && code !== 10 && code !== 13;
                        }).length;
                        const isBinary = hasNullBytes || (nonPrintableCount / decodedContent.length > 0.1);

                        const content = isBinary ? '' : decodedContent;
                        setFileContent({ content, encoding: 'utf8', isBinary });
                        storage.getState().applyFileCache(sessionId!, filePath, content, fetchedDiff, isBinary);
                    } else {
                        setError(response.error || 'Failed to read file');
                    }
                }
            } catch (error) {
                console.error('Failed to load file:', error);
                if (!isCancelled) {
                    setError('Failed to load file');
                }
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadFile();

        return () => {
            isCancelled = true;
        };
    }, [filePath, gitDiffPath, isBinaryFile, sessionId, sessionPath]);

    // Show error modal if there's an error
    React.useEffect(() => {
        if (error) {
            Modal.alert(t('common.error'), error);
        }
    }, [error]);

    // Set default display mode based on diff availability
    React.useEffect(() => {
        if (requestedLine !== null && requestedLine > 0) {
            setDisplayMode('file');
        } else if (diffContent) {
            setDisplayMode('diff');
        } else if (fileContent) {
            setDisplayMode('file');
        }
    }, [diffContent, fileContent, requestedLine]);

    React.useEffect(() => {
        if (!fileContent?.content || displayMode !== 'file' || requestedLine === null || requestedLine <= 0) {
            return;
        }
        const offset = Math.max(0, ((requestedLine - 1) * 20) - 40);
        requestAnimationFrame(() => {
            scrollViewRef.current?.scrollTo({ y: offset, animated: false });
        });
    }, [displayMode, fileContent?.content, requestedLine]);

    const fileName = filePath.split('/').pop() || filePath;
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

    if (error) {
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
                    {error}
                </Text>
            </View>
        );
    }

    if (fileContent?.isBinary) {
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
                    onPress={() => copyContent(displayMode === 'diff' && diffContent ? diffContent : fileContent?.content)}
                    onLongPress={() => openTextSelection(displayMode === 'diff' && diffContent ? diffContent : fileContent?.content)}
                    hitSlop={8}
                    style={styles.ctrlBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Copy contents (long-press to select text)"
                >
                    <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={17} color={copied ? theme.colors.textLink : theme.colors.textSecondary} />
                </Pressable>
            </View>

            {/* Toggle buttons for File/Diff view */}
            {diffContent && (
                <View style={{
                    flexDirection: 'row',
                    paddingHorizontal: 16,
                    paddingVertical: 12,
                    borderBottomWidth: Platform.select({ ios: 0.33, default: 1 }),
                    borderBottomColor: theme.colors.divider,
                    backgroundColor: theme.colors.surface
                }}>
                    <Pressable
                        onPress={() => setDisplayMode('diff')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'diff' ? theme.colors.textLink : theme.colors.input.background,
                            marginRight: 8
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'diff' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.diff')}
                        </Text>
                    </Pressable>

                    <Pressable
                        onPress={() => setDisplayMode('file')}
                        style={{
                            paddingHorizontal: 16,
                            paddingVertical: 8,
                            borderRadius: 8,
                            backgroundColor: displayMode === 'file' ? theme.colors.textLink : theme.colors.input.background
                        }}
                    >
                        <Text style={{
                            fontSize: 14,
                            fontWeight: '600',
                            color: displayMode === 'file' ? 'white' : theme.colors.textSecondary,
                            ...Typography.default()
                        }}>
                            {t('files.file')}
                        </Text>
                    </Pressable>
                </View>
            )}

            {/* Content display */}
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
                ) : displayMode === 'file' && fileContent?.content ? (
                    wrap ? (
                        <SimpleSyntaxHighlighter code={fileContent.content} language={language} selectable={true} fontSize={fontSize ?? 14} wrap={true} />
                    ) : (
                        <ScrollView horizontal showsHorizontalScrollIndicator={true}>
                            <SimpleSyntaxHighlighter code={fileContent.content} language={language} selectable={true} fontSize={fontSize ?? 14} wrap={false} />
                        </ScrollView>
                    )
                ) : displayMode === 'file' && fileContent && !fileContent.content ? (
                    <Text style={{
                        fontSize: 16,
                        color: theme.colors.textSecondary,
                        fontStyle: 'italic',
                        ...Typography.default()
                    }}>
                        {t('files.fileEmpty')}
                    </Text>
                ) : !diffContent && !fileContent?.content ? (
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
