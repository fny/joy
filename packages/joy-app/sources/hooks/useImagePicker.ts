/**
 * File picker hook for attaching files to messages.
 *
 * Three entry points (the composer's attach menu):
 *  - pickImages: expo-document-picker, any file type. No media-library
 *    permission needed; non-image files carry as generic attachments (the
 *    daemon writes them into the session cwd for the agent to read).
 *  - pickFromLibrary: expo-image-picker photo library (system PHPicker /
 *    Photo Picker — also permissionless). The document picker can't browse
 *    Photos, which made photos unreachable on iOS until this was added.
 *  - pasteImage: expo-clipboard image → cache file. Native paste into a RN
 *    TextInput never surfaces image data, so this menu action is the only
 *    native path for clipboard screenshots (web intercepts paste events).
 *
 * For image files it also resolves pixel dimensions + a thumbhash so the chat
 * bubble can render them inline.
 *
 * Enforces limits: max 20 files per message, 10MB per file.
 *
 * Note: size from expo-document-picker is optional — some platforms do not
 * provide it (returns undefined → size=0). Such files pass the client-side
 * size check; the server enforces the limit on upload.
 */
import { useState, useCallback, useRef, useEffect } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { cacheDirectory, writeAsStringAsync, EncodingType } from 'expo-file-system/legacy';
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
    pickFromLibrary: () => Promise<void>;
    pasteImage: () => Promise<void>;
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

/** Shared per-file pipeline: size gate, iOS JPEG transcode for images,
 *  dimensions + thumbhash. Returns null when rejected (too large). */
async function buildPreview(input: {
    uri: string;
    name: string;
    size: number;
    mimeType: string;
}): Promise<AttachmentPreview | null> {
    const { size } = input;
    let { uri, name, mimeType } = input;

    if (size > MAX_FILE_SIZE) {
        Modal.alert(
            t('imageUpload.fileTooLargeTitle'),
            t('imageUpload.fileTooLargeMessage', { name, maxMb: 10 }),
            [{ text: t('common.ok') }],
        );
        return null;
    }

    const isImage = mimeType.startsWith('image/');
    let width = 0;
    let height = 0;
    let thumbhash: string | undefined;
    if (isImage) {
        // iOS: transcode HEIC/etc → JPEG (Claude rejects HEIC; the daemon
        // can't sniff it). Best-effort: keep the original on failure.
        if (Platform.OS === 'ios' && mimeType !== 'image/jpeg' && mimeType !== 'image/png') {
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

    return {
        id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
        uri,
        width,
        height,
        mimeType,
        size,
        name,
        thumbhash,
    };
}

export function useImagePicker(): UseImagePickerResult {
    const [selectedImages, setSelectedImages] = useState<AttachmentPreview[]>([]);
    // Ref tracks current count to avoid stale closures on rapid taps.
    const selectedCountRef = useRef(0);
    useEffect(() => {
        selectedCountRef.current = selectedImages.length;
    }, [selectedImages]);

    const remainingOrAlert = useCallback((): number => {
        const remaining = MAX_IMAGES_PER_MESSAGE - selectedCountRef.current;
        if (remaining <= 0) {
            Modal.alert(
                t('imageUpload.limitTitle'),
                t('imageUpload.limitMessage', { max: MAX_IMAGES_PER_MESSAGE }),
                [{ text: t('common.ok') }],
            );
        }
        return remaining;
    }, []);

    const append = useCallback((previews: AttachmentPreview[]) => {
        if (previews.length === 0) return;
        setSelectedImages(prev => [...prev, ...previews].slice(0, MAX_IMAGES_PER_MESSAGE));
    }, []);

    const pickImages = useCallback(async () => {
        const remaining = remainingOrAlert();
        if (remaining <= 0) return;

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
            const p = await buildPreview({
                uri: asset.uri,
                name: asset.name ?? `file_${Date.now()}`,
                size: asset.size ?? 0,
                mimeType: asset.mimeType ?? 'application/octet-stream',
            });
            if (p) previews.push(p);
        }
        append(previews);
    }, [remainingOrAlert, append]);

    // Photo library via the system picker (PHPicker / Android Photo Picker) —
    // permissionless, images only. The Files picker above cannot reach Photos.
    const pickFromLibrary = useCallback(async () => {
        const remaining = remainingOrAlert();
        if (remaining <= 0) return;

        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsMultipleSelection: true,
            selectionLimit: remaining,
            quality: 1,
        });
        if (result.canceled || !result.assets?.length) return;

        const previews: AttachmentPreview[] = [];
        for (const asset of result.assets.slice(0, remaining)) {
            const p = await buildPreview({
                uri: asset.uri,
                name: asset.fileName ?? `photo_${Date.now()}.jpg`,
                size: asset.fileSize ?? 0,
                mimeType: asset.mimeType ?? 'image/jpeg',
            });
            if (p) previews.push(p);
        }
        append(previews);
    }, [remainingOrAlert, append]);

    // Clipboard image → cache file → preview. The only native path for
    // pasting screenshots: RN TextInputs drop image pasteboard content.
    const pasteImage = useCallback(async () => {
        const remaining = remainingOrAlert();
        if (remaining <= 0) return;

        let img: { data: string } | null = null;
        try {
            img = await Clipboard.getImageAsync({ format: 'jpeg' });
        } catch { /* fall through to the no-image alert */ }
        const data = img?.data;
        if (!data) {
            Modal.alert(t('imageUpload.pasteNoImageTitle'), t('imageUpload.pasteNoImageMessage'), [{ text: t('common.ok') }]);
            return;
        }

        try {
            const base64 = data.includes(',') ? data.slice(data.indexOf(',') + 1) : data;
            const uri = `${cacheDirectory}pasted_${Date.now()}.jpg`;
            await writeAsStringAsync(uri, base64, { encoding: EncodingType.Base64 });
            const p = await buildPreview({
                uri,
                name: `pasted_${Date.now()}.jpg`,
                size: Math.floor(base64.length * 0.75),
                mimeType: 'image/jpeg',
            });
            if (p) append([p]);
        } catch (e) {
            // A silent failure here read as "paste is broken" with no clue why.
            Modal.alert(t('common.error'), String(e), [{ text: t('common.ok') }]);
        }
    }, [remainingOrAlert, append]);

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

    return { selectedImages, pickImages, pickFromLibrary, pasteImage, removeImage, clearImages, addImages };
}
