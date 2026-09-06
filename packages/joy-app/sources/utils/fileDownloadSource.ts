/**
 * Which bytes the file viewer's Download writes (#164).
 *
 * The viewer decodes the daemon's base64 as UTF-8 for DISPLAY; a Latin-1
 * "café" (63 61 66 e9) decodes with U+FFFD in place of e9 and a UTF-8 BOM is
 * dropped. Re-encoding that text produced a download that no longer matched
 * the file on disk. Download therefore prefers the original base64 the
 * viewer fetched; when the screen only has cached text (no base64 in
 * memory), the caller re-reads the bytes from the machine. Decoded text is
 * the last resort, for a session with no backend to read from.
 */
export type DownloadPayload =
    | { kind: 'base64'; base64: string }
    | { kind: 'refetch' }
    | { kind: 'utf8'; text: string };

export function pickDownloadPayload(input: {
    imageBase64: string | null;
    rawBase64: string | null;
    isBinary: boolean;
    displayText: string | null;
    canRefetch: boolean;
}): DownloadPayload {
    if (input.imageBase64) return { kind: 'base64', base64: input.imageBase64 };
    if (input.rawBase64 !== null) return { kind: 'base64', base64: input.rawBase64 };
    if (input.canRefetch) return { kind: 'refetch' };
    if (input.isBinary) return { kind: 'base64', base64: '' };
    return { kind: 'utf8', text: input.displayText ?? '' };
}
