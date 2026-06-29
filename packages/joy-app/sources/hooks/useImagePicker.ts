/**
 * File picker hook for attaching files to messages.
 *
 * Wraps expo-document-picker (any file type). For image files it also resolves
 * pixel dimensions + a thumbhash so the chat bubble can render them inline;
 * non-image files are carried as a generic attachment (the daemon writes them
 * into the session cwd and appends the path for the agent to read).
 *
 * Enforces limits: max 20 files per message, 10MB per file.
 *
 * Note: size from expo-document-picker is optional — some platforms do not
 * provide it (returns undefined → size=0). Such files pass the client-side
 * size check; the server enforces the limit on upload.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import { Image, Platform } from 'react-native';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { Modal } from '@/modal';
import { generateThumbhash } from '@/utils/thumbhash';
import { t } from '@/text';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

// iOS hands back HEIC from the photo library, which Claude's API rejects (and
// the daemon's magic-byte sniff doesn't recognize → it'd be written as a generic
// file, not an inline image). Transcode picked images to JPEG on iOS so they
// upload + render as images. (Mirrors upstream's normalizePickedAssetForUpload.)
const IOS_JPEG_QUALITY = 0.92;
function withJpegExtension(name: string): string {
    return name.replace(/\.[^./\\]*$/, '') + '.jpg';
}

export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export type { AttachmentPreview };

type UseImagePickerResult = {
    selectedImages: AttachmentPreview[];
    pickImages: () => Promise<void>;
    removeImage: (id: string) => void;
    clearImages: () => void;
    addImages: (images: AttachmentPreview[]) => void;
};

// Resolve an image's pixel dimensions, or null if it can't be loaded (e.g. the
// file isn't really an image). Used to drive inline rendering + thumbhash.
function getImageSize(uri: string): Promise<{ width: number; height: number } | null> {
    return new Promise((resolve) => {
        Image.getSize(
            uri,
            (width, height) => resolve({ width, height }),
            () => resolve(null),
        );
    });
}

export function useImagePicker(): UseImagePickerResult {
    const [selectedImages, setSelectedImages] = useState<AttachmentPreview[]>([]);
    // Ref tracks current count to avoid stale closures on rapid taps.
    const selectedCountRef = useRef(0);
    useEffect(() => {
        selectedCountRef.current = selectedImages.length;
    }, [selectedImages]);

    const pickImages = useCallback(async () => {
        const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
            return;
        }

        // Any file type. The system file picker handles its own access — no
        // media-library permission needed (unlike the old image-library flow).
        const result = await DocumentPicker.getDocumentAsync({
            type: '*/*',
            multiple: true,
            copyToCacheDirectory: true,
        });

        if (result.canceled || !result.assets?.length) return;

        // On web, the multiple-select limit is not enforced — clamp here.
        const assets = result.assets.slice(0, remaining);
        const previews: AttachmentPreview[] = [];

        for (const asset of assets) {
            const size = asset.size ?? 0;

            if (size > MAX_FILE_SIZE) {
                Modal.alert(
                    t('imageUpload.fileTooLargeTitle'),
                    t('imageUpload.fileTooLargeMessage', { name: asset.name ?? 'file', maxMb: 10 }),
                    [{ text: t('common.ok') }],
                );
                continue;
            }

            let mimeType = asset.mimeType ?? 'application/octet-stream';
            const isImage = mimeType.startsWith('image/');
            let uri = asset.uri;
            let name = asset.name ?? `file_${Date.now()}`;

            // For images, resolve dimensions + thumbhash so the message renders
            // the picture inline; non-images stay a plain attachment.
            let width = 0;
            let height = 0;
            let thumbhash: string | undefined;
            if (isImage) {
                // iOS: transcode HEIC/etc → JPEG (Claude rejects HEIC; the daemon
                // can't sniff it). Best-effort: keep the original on failure.
                if (Platform.OS === 'ios') {
                    try {
                        const jpeg = await manipulateAsync(uri, [], { compress: IOS_JPEG_QUALITY, format: SaveFormat.JPEG });
                        uri = jpeg.uri;
                        mimeType = 'image/jpeg';
                        name = withJpegExtension(name);
                    } catch { /* keep original */ }
                }
                const dims = await getImageSize(uri);
                if (dims && dims.width > 0 && dims.height > 0) {
                    width = dims.width;
                    height = dims.height;
                    thumbhash = await generateThumbhash(uri, width, height);
                }
            }

            previews.push({
                id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
                uri,
                width,
                height,
                mimeType,
                size,
                name,
                thumbhash,
            });
        }

        if (previews.length > 0) {
            setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
        }
    }, []);

    const removeImage = useCallback((id: string) => {
        setSelectedImages(prev => prev.filter(img => img.id !== id));
    }, []);

    const clearImages = useCallback(() => {
        setSelectedImages([]);
    }, []);

    const addImages = useCallback((images: AttachmentPreview[]) => {
        setSelectedImages(prev => {
            const remaining = MAX_IMAGES_PER_MESSAGE - prev.length;
            if (remaining <= 0) return prev;
            return [...prev, ...images.slice(0, remaining)];
        });
    }, []);

    return { selectedImages, pickImages, removeImage, clearImages, addImages };
}
