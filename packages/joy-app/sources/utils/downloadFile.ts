import { Platform } from 'react-native';

/**
 * Save a file the viewer has in memory to the user's device.
 * Web/desktop: a real browser download (blob + anchor). Native: write to the
 * cache dir and open the share sheet (the iOS/Android idiom for "download").
 */
export async function downloadFile(fileName: string, data: { utf8?: string; base64?: string }): Promise<void> {
    if (Platform.OS === 'web') {
        let blob: Blob;
        if (data.base64 != null) {
            const binary = atob(data.base64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            blob = new Blob([bytes]);
        } else {
            blob = new Blob([data.utf8 ?? ''], { type: 'text/plain;charset=utf-8' });
        }
        const url = URL.createObjectURL(blob);
        try {
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
        } finally {
            // Revoke on a delay: revoking synchronously races the click in
            // some browsers and yields an empty download.
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        }
        return;
    }
    const { cacheDirectory, writeAsStringAsync, EncodingType } = require('expo-file-system/legacy');
    const Sharing = require('expo-sharing');
    // Sanitize: the share target sees this name; path separators would break the write.
    const safeName = fileName.replace(/[/\\]/g, '_') || 'file';
    const uri = `${cacheDirectory}${Date.now()}-${safeName}`;
    if (data.base64 != null) {
        await writeAsStringAsync(uri, data.base64, { encoding: EncodingType.Base64 });
    } else {
        await writeAsStringAsync(uri, data.utf8 ?? '', { encoding: EncodingType.UTF8 });
    }
    await Sharing.shareAsync(uri);
}
