import * as React from 'react';
import { View, Pressable, Text, ActivityIndicator, Modal, ScrollView, Platform, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet } from 'react-native-unistyles';
import { sessionReadFile } from '@/sync/ops';
import { joyImgMime } from '@/utils/joyImg';

/**
 * Inline chat image for <joy-img/> tags. Bytes come over the session's
 * readFile RPC (end-to-end encrypted, on demand — nothing is stored on the
 * server), rendered as a data: URI. The width/height attrs reserve the layout
 * box before bytes arrive so the chat never jumps. Tap opens a full-screen
 * pinch-zoom viewer of the same image.
 *
 * Files live under ~/.joy/sessions/<id>/media/ on the machine (the readFile
 * jail admits exactly that session's folder). A deleted file renders as a
 * quiet placeholder with the alt text.
 */

// Fetched data-URI cache — messages re-render constantly while streaming, and
// scrolling back re-mounts; refetching a few-hundred-KB image each time would
// hammer the RPC channel. Keyed per session+path; modest cap, oldest evicted.
const cache = new Map<string, string>();
const CACHE_MAX = 40;
// In-flight fetches, deduped per key: two mounts of the same src (or a fast
// unmount/remount during scroll) share one RPC instead of issuing duplicates.
const inFlight = new Map<string, Promise<string | null>>();

function cacheGet(key: string): string | undefined {
    return cache.get(key);
}

function cachePut(key: string, value: string): void {
    if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
}

export const JoyImage = React.memo((props: {
    sessionId: string;
    src: string;
    width: number | null;
    height: number | null;
    alt: string | null;
}) => {
    const { sessionId, src } = props;
    const key = `${sessionId}:${src}`;
    const [uri, setUri] = React.useState<string | null>(() => cacheGet(key) ?? null);
    const [failed, setFailed] = React.useState(false);
    const [viewer, setViewer] = React.useState(false);
    const { width: screenWidth, height: screenHeight } = useWindowDimensions();

    React.useEffect(() => {
        let alive = true;
        const cached = cacheGet(key);
        if (cached) { setUri(cached); return; }
        setUri(null);
        setFailed(false);
        // The fetch (and cachePut) completes even if this row unmounts mid-RPC —
        // discarding a few-hundred-KB payload because FlashList recycled the row
        // meant scrolling back refetched the whole image. Only the setState is
        // gated on being mounted.
        let p = inFlight.get(key);
        if (!p) {
            p = (async () => {
                const res = await sessionReadFile(sessionId, src);
                if (res.success && res.content) {
                    const dataUri = `data:${joyImgMime(src)};base64,${res.content}`;
                    cachePut(key, dataUri);
                    return dataUri;
                }
                return null;
            })().finally(() => { inFlight.delete(key); });
            inFlight.set(key, p);
        }
        void p.then((dataUri) => {
            if (!alive) return;
            if (dataUri) setUri(dataUri); else setFailed(true);
        });
        return () => { alive = false; };
    }, [key, sessionId, src]);

    // Reserve the exact aspect box from the tag's dimensions; fall back to a
    // pleasant 16:9 when the agent omitted them.
    const aspectRatio = props.width && props.height ? props.width / props.height : 16 / 9;
    const maxWidth = props.width ?? 854;

    if (failed) {
        return (
            <View style={[styles.placeholder, { aspectRatio, maxWidth }]}>
                <Text style={styles.placeholderText}>{props.alt ?? src.split('/').pop()}</Text>
            </View>
        );
    }

    return (
        <>
            <Pressable
                onPress={uri ? () => setViewer(true) : undefined}
                accessibilityRole="imagebutton"
                accessibilityLabel={props.alt ?? undefined}
                style={[styles.frame, { aspectRatio, maxWidth }]}
            >
                {uri ? (
                    <Image
                        source={{ uri }}
                        style={{ width: '100%', height: '100%' }}
                        contentFit="contain"
                        accessibilityLabel={props.alt ?? undefined}
                    />
                ) : (
                    <ActivityIndicator />
                )}
            </Pressable>
            <Modal visible={viewer} transparent animationType="fade" onRequestClose={() => setViewer(false)}>
                <View style={styles.viewerBackdrop}>
                    <ScrollView
                        style={{ flex: 1 }}
                        contentContainerStyle={styles.viewerContent}
                        maximumZoomScale={6}
                        minimumZoomScale={1}
                        // iOS ScrollView pinch-zoom; on Android/web the image still
                        // shows full-screen (contain) — zoom gestures are iOS-first.
                        centerContent={Platform.OS === 'ios'}
                    >
                        {uri && (
                            <Image
                                source={{ uri }}
                                style={{ width: screenWidth, height: screenHeight }}
                                contentFit="contain"
                            />
                        )}
                    </ScrollView>
                    <Pressable style={styles.viewerClose} onPress={() => setViewer(false)} accessibilityRole="button">
                        <Text style={styles.viewerCloseText}>✕</Text>
                    </Pressable>
                </View>
            </Modal>
        </>
    );
});

const styles = StyleSheet.create((theme) => ({
    frame: {
        width: '100%',
        marginVertical: 8,
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: theme.colors.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
    },
    placeholder: {
        width: '100%',
        marginVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 12,
    },
    placeholderText: {
        color: theme.colors.textSecondary,
        fontSize: 13,
        fontStyle: 'italic',
    },
    viewerBackdrop: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.95)',
    },
    viewerContent: {
        flexGrow: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    viewerClose: {
        position: 'absolute',
        top: 54,
        right: 20,
        width: 36,
        height: 36,
        borderRadius: 18,
        backgroundColor: 'rgba(255,255,255,0.15)',
        alignItems: 'center',
        justifyContent: 'center',
    },
    viewerCloseText: {
        color: '#fff',
        fontSize: 16,
    },
}));
