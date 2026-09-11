/** Encoding helpers shared by the two file editors (the phone's file screen
 *  and the desktop panel): the daemon takes base64 content and a sha256 of
 *  the version the editor was seeded from. */

export function encodeStringToBase64(str: string): string {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/** SHA-256 of a UTF-8 string — matches the daemon's
 *  crypto.createHash('sha256').update(bytes).digest('hex'). */
export async function computeSHA256(content: string): Promise<string> {
    const data = new TextEncoder().encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
