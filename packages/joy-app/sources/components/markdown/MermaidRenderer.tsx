import * as React from 'react';
import { View, Platform, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

// Style for Web platform
const webStyle: any = {
    backgroundColor: '#1a1a1a',
    borderRadius: 8,
    padding: 16,
    overflow: 'auto',
};

// Every render attempt gets its own SVG id. Mermaid removes any existing
// element with the id it is given before drawing, so two diagrams whose
// imports resolved in the same millisecond (one `Date.now()` id) deleted each
// other and the survivors shared an id (#260). A module counter cannot collide.
let mermaidRenderSeq = 0;
function nextMermaidId(): string {
    mermaidRenderSeq += 1;
    return `mermaid-${mermaidRenderSeq}-${Date.now().toString(36)}`;
}

// Mermaid renders into a temporary element under document.body (and, when
// the diagram is invalid, an error SVG) that it does not always remove before
// throwing — invalid mid-stream content left one per attempt behind (#261).
function removeMermaidScratch(id: string) {
    if (typeof document === 'undefined') return;
    for (const scratchId of [id, `d${id}`]) {
        document.getElementById(scratchId)?.remove();
    }
}

// Native: the WebView measures its own document and posts the height.
const NATIVE_INITIAL_HEIGHT = 200;

// Mermaid render component that works on all platforms
export const MermaidRenderer = React.memo((props: {
    content: string;
}) => {
    const { theme } = useUnistyles();
    const [dimensions, setDimensions] = React.useState({ width: 0, height: NATIVE_INITIAL_HEIGHT });
    const [measured, setMeasured] = React.useState(false);
    const [svgContent, setSvgContent] = React.useState<string | null>(null);

    const onLayout = React.useCallback((event: any) => {
        const { width } = event.nativeEvent.layout;
        setDimensions(prev => ({ ...prev, width }));
    }, []);

    // Web platform uses direct SVG rendering for better performance and native DOM integration
    if (Platform.OS === 'web') {
        const [hasError, setHasError] = React.useState(false);

        React.useEffect(() => {
            let isMounted = true;
            setHasError(false);

            const renderId = nextMermaidId();
            const renderMermaid = async () => {
                try {
                    const mermaidModule: any = await import('mermaid');
                    const mermaid = mermaidModule.default || mermaidModule;

                    if (mermaid.initialize) {
                        mermaid.initialize({
                            startOnLoad: false,
                            theme: 'dark',
                            // Failures surface through our own error view; without
                            // this Mermaid also drew an error SVG into document.body
                            // and threw before removing it (#261).
                            suppressErrorRendering: true,
                        });
                    }

                    if (mermaid.render) {
                        const { svg } = await mermaid.render(renderId, props.content);

                        if (isMounted) {
                            setSvgContent(svg);
                        }
                    }
                } catch (error) {
                    if (isMounted) {
                        console.warn(`[Mermaid] ${t('markdown.mermaidRenderFailed')}: ${error instanceof Error ? error.message : String(error)}`);
                        setHasError(true);
                    }
                } finally {
                    removeMermaidScratch(renderId);
                }
            };

            renderMermaid();

            return () => {
                isMounted = false;
                removeMermaidScratch(renderId);
            };
        }, [props.content]);

        if (hasError) {
            return (
                <View style={[style.container, style.errorContainer]}>
                    <View style={style.errorContent}>
                        <Text style={style.errorText}>Mermaid diagram syntax error</Text>
                        <View style={style.codeBlock}>
                            <Text style={style.codeText}>{props.content}</Text>
                        </View>
                    </View>
                </View>
            );
        }

        if (!svgContent) {
            return (
                <View style={[style.container, style.loadingContainer]}>
                    <View style={style.loadingPlaceholder} />
                </View>
            );
        }

        return (
            <View style={style.container}>
                {/* @ts-ignore - Web only */}
                <div
                    style={webStyle}
                    dangerouslySetInnerHTML={{ __html: svgContent }}
                />
            </View>
        );
    }

    // For iOS/Android, use WebView
    // Pass mermaid content via JSON to prevent XSS from HTML interpolation
    // JSON.stringify does not escape "</": a diagram containing "</script>"
    // (agent output, a pasted page) broke out of the inline script (#17).
    const mermaidContent = JSON.stringify(props.content).replace(/</g, '\\u003c');
    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>
            <style>
                body {
                    margin: 0;
                    padding: 16px;
                    background-color: ${theme.colors.surfaceHighest};
                }
                #mermaid-container {
                    display: flex;
                    justify-content: center;
                    align-items: center;
                    width: 100%;
                }
                #mermaid-container svg {
                    max-width: 100%;
                    height: auto;
                }
                .error {
                    color: #ff6b6b;
                    font-family: monospace;
                    white-space: pre-wrap;
                }
            </style>
        </head>
        <body>
            <div id="mermaid-container"></div>
            <script>
                (async function() {
                    const content = ${mermaidContent};
                    const container = document.getElementById('mermaid-container');
                    // The native side sizes the WebView from these messages: a
                    // tall diagram stayed clipped to the initial 200px because
                    // nothing was ever posted (#259). Measure after insertion
                    // and again whenever the document's size changes.
                    const postHeight = function() {
                        if (!window.ReactNativeWebView) return;
                        const height = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
                        if (height > 0) {
                            window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'dimensions', height: height }));
                        }
                    };
                    if (typeof ResizeObserver === 'function') {
                        new ResizeObserver(postHeight).observe(document.body);
                    }

                    try {
                        mermaid.initialize({
                            startOnLoad: false,
                            theme: 'dark'
                        });

                        const { svg } = await mermaid.render('mermaid-diagram', content);
                        container.innerHTML = svg;
                    } catch (error) {
                        container.innerHTML = '<div class="error">Diagram error: ' +
                            (error.message || String(error)).replace(/</g, '&lt;').replace(/>/g, '&gt;') +
                            '</div>';
                    }
                    postHeight();
                    setTimeout(postHeight, 250);
                })();
            </script>
        </body>
        </html>
    `;

    return (
        <View style={style.container} onLayout={onLayout}>
            <View style={[style.innerContainer, { height: dimensions.height }]}>
                <WebView
                    source={{ html }}
                    style={{ flex: 1 }}
                    // Until the document reports its height the viewport may be
                    // too short, so scrolling stays available as the fallback;
                    // once sized to the diagram there is nothing to scroll (#259).
                    scrollEnabled={!measured}
                    onMessage={(event) => {
                        // Anything in the WebView can postMessage: never let a
                        // non-JSON payload throw in the native callback (#17).
                        let data: { type?: unknown; height?: unknown };
                        try { data = JSON.parse(event.nativeEvent.data); } catch { return; }
                        if (!data || typeof data !== 'object') return;
                        const height = data.height;
                        if (data.type === 'dimensions' && typeof height === 'number' && Number.isFinite(height) && height > 0) {
                            // Clamp: a runaway document must not grow the chat unboundedly.
                            const clamped = Math.min(Math.max(Math.round(height), NATIVE_INITIAL_HEIGHT), 4000);
                            setMeasured(true);
                            setDimensions(prev => (prev.height === clamped ? prev : { ...prev, height: clamped }));
                        }
                    }}
                />
            </View>
        </View>
    );
});

const style = StyleSheet.create((theme) => ({
    container: {
        marginVertical: 8,
        width: '100%',
    },
    innerContainer: {
        width: '100%',
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
    },
    loadingContainer: {
        justifyContent: 'center',
        alignItems: 'center',
        height: 100,
    },
    loadingPlaceholder: {
        width: 200,
        height: 20,
        backgroundColor: theme.colors.divider,
        borderRadius: 4,
    },
    errorContainer: {
        backgroundColor: theme.colors.surfaceHighest,
        borderRadius: 8,
        padding: 16,
    },
    errorContent: {
        flexDirection: 'column',
        gap: 12,
    },
    errorText: {
        ...Typography.default('semiBold'),
        color: theme.colors.text,
        fontSize: 16,
    },
    codeBlock: {
        backgroundColor: theme.colors.surfaceHigh,
        borderRadius: 4,
        padding: 12,
    },
    codeText: {
        ...Typography.mono(),
        color: theme.colors.text,
        fontSize: 14,
        lineHeight: 20,
    },
}));
