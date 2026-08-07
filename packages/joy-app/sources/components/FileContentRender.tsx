import * as React from 'react';
import { Platform, ScrollView, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@/components/StyledText';
import { MarkdownView } from '@/components/markdown/MarkdownView';
import { Typography } from '@/constants/Typography';
import { useUnistyles } from 'react-native-unistyles';

// Rich rendering for the file viewer. A file is classified once by extension;
// renderable kinds get a source ⇄ rendered toggle in the viewer (SOURCE is the
// default — rendering is the opt-in). Images are rendered-only (no text form).

export { fileRenderKind, isRasterImagePath, imageDataUri, parseDelimited } from '@/utils/fileRender';
export type { FileRenderKind } from '@/utils/fileRender';
import { fileRenderKind, imageDataUri, parseDelimited } from '@/utils/fileRender';

const TableView = React.memo(({ text, delimiter }: { text: string; delimiter: ',' | '\t' }) => {
    const { theme } = useUnistyles();
    const { rows, truncated } = React.useMemo(() => parseDelimited(text, delimiter), [text, delimiter]);
    if (rows.length === 0) return <Text style={{ color: theme.colors.textSecondary, padding: 16 }}>empty file</Text>;
    const [header, ...body] = rows;
    const cellStyle = { paddingVertical: 6, paddingHorizontal: 10, minWidth: 60, maxWidth: 320 } as const;
    const textStyle = { ...Typography.mono(), fontSize: 12, color: theme.colors.text } as const;
    return (
        <ScrollView horizontal showsHorizontalScrollIndicator>
            <View>
                <View style={{ flexDirection: 'row', backgroundColor: theme.colors.surfaceHigh, borderBottomWidth: 1, borderBottomColor: theme.colors.divider }}>
                    {header.map((h, i) => (
                        <View key={i} style={cellStyle}>
                            <Text style={{ ...textStyle, fontWeight: '700' }} numberOfLines={2}>{h}</Text>
                        </View>
                    ))}
                </View>
                {body.map((r, ri) => (
                    <View key={ri} style={{ flexDirection: 'row', backgroundColor: ri % 2 ? theme.colors.surfaceHigh : 'transparent' }}>
                        {header.map((_, ci) => (
                            <View key={ci} style={cellStyle}>
                                <Text style={textStyle} numberOfLines={4} selectable>{r[ci] ?? ''}</Text>
                            </View>
                        ))}
                    </View>
                ))}
                {truncated && (
                    <Text style={{ ...textStyle, color: theme.colors.textSecondary, padding: 10 }}>
                        … truncated at 500 rows — download for the full file
                    </Text>
                )}
            </View>
        </ScrollView>
    );
});

// ── HTML ────────────────────────────────────────────────────────────────────

// Self-contained HTML runs with JS enabled. Web: sandboxed iframe (scripts
// allowed, same-origin NOT — the document runs opaque-origin so it can't touch
// the app's cookies/storage). Native: WebView with no navigation escape.
const HtmlView = React.memo(({ html }: { html: string }) => {
    if (Platform.OS === 'web') {
        return React.createElement('iframe', {
            srcDoc: html,
            sandbox: 'allow-scripts allow-popups allow-modals allow-forms',
            style: { border: 'none', width: '100%', height: '100%', backgroundColor: '#fff' },
        });
    }
    const WebView = require('react-native-webview').WebView;
    return (
        <WebView
            originWhitelist={['about:blank', 'data:*']}
            source={{ html }}
            javaScriptEnabled
            onShouldStartLoadWithRequest={() => false}
            style={{ flex: 1, backgroundColor: '#fff' }}
        />
    );
});

// ── The rendered view ───────────────────────────────────────────────────────

export const FileRenderedView = React.memo((props: {
    filePath: string;
    /** utf8 text for text kinds (md/html/csv/tsv/svg). */
    content?: string | null;
    /** base64 for raster images. */
    base64?: string | null;
}) => {
    const { theme } = useUnistyles();
    const { height } = useWindowDimensions();
    const kind = fileRenderKind(props.filePath);
    if (kind === 'image') {
        const uri = imageDataUri(props.filePath, { base64: props.base64 ?? undefined, utf8: props.content ?? undefined });
        if (!uri) return <Text style={{ color: theme.colors.textSecondary, padding: 16 }}>image unavailable</Text>;
        return (
            <ScrollView contentContainerStyle={{ padding: 16, alignItems: 'center' }} maximumZoomScale={5} minimumZoomScale={1}>
                <Image
                    source={{ uri }}
                    style={{ width: '100%', height: height * 0.75 }}
                    contentFit="contain"
                    accessibilityLabel={props.filePath.split('/').pop()}
                />
            </ScrollView>
        );
    }
    const text = props.content ?? '';
    if (kind === 'markdown') {
        return (
            <ScrollView contentContainerStyle={{ padding: 16, maxWidth: 800, width: '100%', alignSelf: 'center' }}>
                <MarkdownView markdown={text} />
            </ScrollView>
        );
    }
    if (kind === 'html') return <HtmlView html={text} />;
    if (kind === 'csv') return <TableView text={text} delimiter="," />;
    if (kind === 'tsv') return <TableView text={text} delimiter={'\t'} />;
    return null;
});
