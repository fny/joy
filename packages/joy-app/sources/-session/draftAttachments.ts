import type { AttachmentPreview } from '@/sync/attachmentTypes';

// No top-level react-native import: these helpers are pure so they can be
// tested directly, and the one platform-dependent function requires its deps
// lazily.

/**
 * Draft attachments are local cache-directory URIs (#650).
 *
 * Nothing in joy deletes them — `releaseAttachmentUris` is a web-only blob
 * revoke — but iOS and Android both purge their cache directories under
 * storage pressure. Never on a schedule, and only while the app is not
 * running, so a draft saved and released in one sitting is never at risk. A
 * draft left for a week on a full phone is.
 *
 * That risk is accepted. What is not acceptable is discovering it silently:
 * releasing a draft that promises three images and sends one. These helpers
 * find the dead references so the UI can say so and the release can refuse.
 */

/** A URI we can meaningfully test for existence. */
function isCheckableFileUri(uri: string): boolean {
    // Web blob:/data: URLs are held by the page, not the filesystem, and
    // content:// (Android SAF) needs a resolver rather than a stat — treating
    // either as "missing" would cry wolf on every draft.
    return uri.startsWith('file://') || uri.startsWith('/');
}

/**
 * Which of these attachments no longer exist on disk.
 *
 * `statFile` is injected so this stays testable without expo-file-system, and
 * so a platform that cannot answer simply reports nothing missing — an
 * unverifiable attachment must never be shown as dead.
 */
export async function findMissingAttachments(
    attachments: ReadonlyArray<Pick<AttachmentPreview, 'uri'>> | undefined,
    statFile: (uri: string) => Promise<boolean>,
): Promise<string[]> {
    if (!attachments || attachments.length === 0) return [];
    const missing: string[] = [];
    for (const a of attachments) {
        if (!a.uri || !isCheckableFileUri(a.uri)) continue;
        let exists = true;
        try {
            exists = await statFile(a.uri);
        } catch {
            // A failed stat is not proof of absence — an unreadable file may be
            // a transient permission or I/O error. Leave it alone.
            exists = true;
        }
        if (!exists) missing.push(a.uri);
    }
    return missing;
}

/** The attachments still backed by a real file, for an actual send. */
export function liveAttachments<T extends { uri: string }>(
    attachments: ReadonlyArray<T> | undefined,
    missing: ReadonlyArray<string> | undefined,
): T[] {
    if (!attachments) return [];
    if (!missing || missing.length === 0) return [...attachments];
    const dead = new Set(missing);
    return attachments.filter((a) => !dead.has(a.uri));
}

/** Real existence check, for the app. Web has no filesystem to consult. */
export async function fileExists(uri: string): Promise<boolean> {
    const { Platform } = require('react-native');
    if (Platform.OS === 'web') return true;
    const { getInfoAsync } = require('expo-file-system/legacy');
    const info = await getInfoAsync(uri);
    return !!info?.exists;
}
