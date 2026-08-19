/**
 * View for 'file' tool calls (image attachments sent by user).
 * Downloads and decrypts the encrypted blob via apiAttachments + sessionBlobKey,
 * then renders the full image inline with the thumbhash as placeholder.
 *
 * Always renders inline when a ref is present — if dimensions are missing
 * (older messages, iOS picker that didn't report w/h), a default 4:3 aspect
 * ratio is used until the actual image lands and contentFit shows it.
 */
import * as React from 'react';
import { View, Text } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolViewProps } from './_all';
import { z } from 'zod';
import { useAttachmentImage } from '@/hooks/useAttachmentImage';
import { thumbhashToDataUri } from '@/utils/thumbhash';

const fileInputSchema = z.object({
    ref: z.string(),
    name: z.string(),
    size: z.number().optional(),
    image: z.object({
        width: z.number(),
        height: z.number(),
        thumbhash: z.string().optional(),
    }).optional(),
});

const BORDER_RADIUS = 8;
const MAX_IMAGE_WIDTH = 280;
const MAX_IMAGE_HEIGHT = 360;
const DEFAULT_ASPECT = 4 / 3; // when wire-format omits image{} dimensions

// Attachments that should render as a picture. The wire's image{} block is
// authoritative; for older messages without it, fall back to the extension.
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|avif)$/i;

function formatSize(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} B`;
}

export const FileView = React.memo<ToolViewProps>(({ tool, sessionId }) => {
    const { theme } = useUnistyles();
    const parsed = fileInputSchema.safeParse(tool.input);
    if (!parsed.success) return null;

    const { name, image, ref, size } = parsed.data;

    const placeholder = React.useMemo(() => {
        if (!image?.thumbhash) return undefined;
        const uri = thumbhashToDataUri(image.thumbhash);
        return uri ? { uri } : undefined;
    }, [image?.thumbhash]);

    // Non-image files, and images whose bytes are gone (expired/deleted
    // attachment), collapse to a compact filename row — a large empty frame
    // communicates nothing. Loading images keep the sized placeholder box so
    // the chat doesn't jump when the bytes land. Non-images skip the byte
    // fetch entirely (nothing to render with them).
    const isImage = !!image || IMAGE_EXT_RE.test(name);
    const { uri, error } = useAttachmentImage(sessionId ?? '', sessionId && isImage ? ref : undefined);
    if (!isImage || (error && !uri)) {
        return (
            <View style={styles.inlineContainer}>
                <View style={[styles.fileRow, { borderColor: theme.colors.divider, backgroundColor: theme.colors.surfaceHigh }]}>
                    <Ionicons name={isImage ? 'image-outline' : 'document-outline'} size={18} color={theme.colors.textSecondary} />
                    <Text style={[styles.fileRowName, { color: theme.colors.text }]} numberOfLines={1}>{name}</Text>
                    {typeof size === 'number' && size > 0 && (
                        <Text style={[styles.fileRowSize, { color: theme.colors.textSecondary }]}>{formatSize(size)}</Text>
                    )}
                    {isImage && (
                        <Ionicons name="alert-circle-outline" size={16} color={theme.colors.textSecondary} />
                    )}
                </View>
            </View>
        );
    }

    // Pick display dimensions. Real w/h drives the aspect ratio when present,
    // but a missing image{} block (older messages, iOS picker that didn't
    // report dimensions) shouldn't downgrade to a compact filename row —
    // the user attached an image, render it inline. Default to 4:3 at the
    // bubble's max width; expo-image's contentFit="cover" handles the
    // mismatch once the real image arrives.
    const aspect = image && image.width > 0 && image.height > 0
        ? image.width / image.height
        : DEFAULT_ASPECT;
    let displayW = Math.min(image?.width && image.width > 0 ? image.width : MAX_IMAGE_WIDTH, MAX_IMAGE_WIDTH);
    let displayH = displayW / aspect;
    if (displayH > MAX_IMAGE_HEIGHT) {
        displayH = MAX_IMAGE_HEIGHT;
        displayW = displayH * aspect;
    }

    return (
        <View style={styles.inlineContainer}>
            <View style={[styles.inlineWrapper, { borderColor: theme.colors.divider }]}>
                <Image
                    source={uri ? { uri } : undefined}
                    placeholder={placeholder}
                    style={[{ width: displayW, height: displayH }, styles.inlineImage]}
                    contentFit="cover"
                    transition={150}
                />
                {error && !uri && (
                    <View style={[styles.errorOverlay, { backgroundColor: theme.colors.surfaceHigh }]}>
                        <Ionicons name="alert-circle-outline" size={20} color={theme.colors.textSecondary} />
                    </View>
                )}
            </View>
            <Text style={[styles.filename, { color: theme.colors.textSecondary }]} numberOfLines={1}>{name}</Text>
        </View>
    );
});

const styles = StyleSheet.create(() => ({
    inlineContainer: {
        paddingHorizontal: 12,
        paddingVertical: 8,
        gap: 4,
    },
    inlineWrapper: {
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        overflow: 'hidden',
        alignSelf: 'flex-start',
        position: 'relative',
    },
    inlineImage: {
        borderRadius: BORDER_RADIUS,
    },
    errorOverlay: {
        position: 'absolute',
        top: 4,
        right: 4,
        width: 24,
        height: 24,
        borderRadius: 12,
        alignItems: 'center',
        justifyContent: 'center',
    },
    filename: {
        fontSize: 13,
        fontWeight: '500',
    },
    fileRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        borderRadius: BORDER_RADIUS,
        borderWidth: 1,
        paddingHorizontal: 10,
        paddingVertical: 8,
        alignSelf: 'flex-start',
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
}));
