// Idempotency key for a relay send. The relay dedupes by clientIntentId ALONE
// (it returns the first acceptance whatever the new payload is), so the key has
// to change whenever the content changes and stay the same for a retry of the
// exact same content: composition id + a hash of text and attachment ids.
// Two in-flight messages never share one, an edited restore gets a new one,
// and an unchanged retry after a lost response replays the acceptance (#7, #10).
export function sendKey(scope: string, text: string, attachmentIds: readonly string[] = []): string {
    const s = `${text}\u0000${attachmentIds.join('\u0001')}`;
    let h = 5381;
    for (let i = 0; i < s.length; i += 1) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
    return `${scope}:${h.toString(16)}`;
}
