/**
 * Renders the attachments a user message cites: images inline (thumbhash
 * placeholder until the sealed bytes are fetched and opened), other files
 * as a compact name + size row. Right-aligned under the user's bubble.
 */
import * as React from 'react';
import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAttachmentImage, INLINE_IMAGE_MIMES, INLINE_IMAGE_EXT_RE } from '@/hooks/useAttachmentImage';
import { thumbhashToDataUri } from '@/utils/thumbhash';
import type { MessageAttachment } from '@/sync/typesRaw';

const BORDER_RADIUS = 12;
const MAX_IMAGE_WIDTH = 280;
const MAX_IMAGE_HEIGHT = 360;
const DEFAULT_ASPECT = 4 / 3; // when the sender did not report dimensions


function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

// The sender's mime is authoritative; fall back to the extension for
// attachments sent without one. Only formats we can actually decode count —
// iOS transcodes HEIC to JPEG at pick time, so those never reach here as HEIC.
function isImageAttachment(a: MessageAttachment): boolean {
    return a.mime ? INLINE_IMAGE_MIMES.has(a.mime.toLowerCase()) : INLINE_IMAGE_EXT_RE.test(a.name);
}

export const AttachmentView = React.memo(function AttachmentView(props: { sessionId: string; attachment: MessageAttachment }) {
    const { theme } = useUnistyles();
    const { sessionId, attachment } = props;
    const { name, size, width, height, thumbhash } = attachment;
    const isImage = isImageAttachment(attachment);

    const placeholder = React.useMemo(() => {
        if (!thumbhash) return undefined;
        const uri = thumbhashToDataUri(thumbhash);
        return uri ? { uri } : undefined;
    }, [thumbhash]);

    // Non-images skip the byte fetch entirely (nothing to render with them).
    // Images whose bytes are gone (expired/purged) collapse to the same row
    // with a warning glyph — a large empty frame communicates nothing.
    const { uri, error } = useAttachmentImage(sessionId, isImage ? attachment.id : undefined);
    if (!isImage || (error && !uri)) {
        return (
            <View style={[styles.fileRow, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
                <Ionicons name={isImage ? 'image-outline' : 'document-outline'} size={18} color={theme.colors.textSecondary} />
                <Text style={[styles.fileRowName, { color: theme.colors.text }]} numberOfLines={1}>{name}</Text>
                {size > 0 && (
                    <Text style={[styles.fileRowSize, { color: theme.colors.textSecondary }]}>{formatSize(size)}</Text>
                )}
                {isImage && (
                    <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textSecondary} />
                )}
                {isImage && error && (
                    <Text style={[styles.fileRowError, { color: theme.colors.textSecondary }]} numberOfLines={2}>{error}</Text>
                )}
            </View>
        );
    }

    // Real w/h drives the aspect ratio when present; otherwise 4:3 at the
    // max width — expo-image's contentFit="cover" reconciles once the real
    // picture arrives, and the box keeps the chat from jumping meanwhile.
    const aspect = width && height && width > 0 && height > 0 ? width / height : DEFAULT_ASPECT;
    let displayW = Math.min(width && width > 0 ? width : MAX_IMAGE_WIDTH, MAX_IMAGE_WIDTH);
    let displayH = displayW / aspect;
    if (displayH > MAX_IMAGE_HEIGHT) {
        displayH = MAX_IMAGE_HEIGHT;
        displayW = displayH * aspect;
    }

    return (
        <View style={[styles.imageWrapper, { borderColor: theme.colors.divider }]}>
            <Image
                source={uri ? { uri } : undefined}
                placeholder={placeholder}
                style={{ width: displayW, height: displayH }}
                contentFit="cover"
                transition={150}
            />
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    imageWrapper: {
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 8,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        paddingHorizontal: 10,
        paddingVertical: 8,
        maxWidth: MAX_IMAGE_WIDTH,
    },
    fileRowName: {
        fontSize: 13,
        fontWeight: '500',
        flexShrink: 1,
    },
    fileRowSize: {
        fontSize: 12,
    },
    fileRowError: {
        fontSize: 11,
        width: '100%',
    },
}));
