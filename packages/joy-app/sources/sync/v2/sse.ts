/**
 * Incremental Server-Sent-Events frame parser — the pure half of
 * connectV2Stream (api.ts), kept free of fetch/auth so it can be fed
 * arbitrarily chunked input in tests.
 *
 * Line endings: the SSE grammar allows CRLF, LF, or a lone CR. Fetch hands
 * the body over in chunks that can split a CRLF pair — the old inline
 * parser normalized CRLF per CHUNK, so a "\r" at the end of one chunk and
 * the "\n" at the start of the next never became a frame boundary (the
 * frame was never dispatched and the buffer grew), and an "event: hello\r"
 * split the same way kept its CR and was routed as a poke with no session
 * id (#414). The parser therefore holds back a trailing CR until the next
 * chunk says whether it is half of a CRLF, and normalizes on the
 * ACCUMULATED text, never per chunk.
 */

export interface SseFrame {
    /** The `event:` field, `message` when absent (per spec). */
    event: string;
    /** All `data:` lines joined with "\n" (per spec). */
    data: string;
}

export interface SseParser {
    /** Feed decoded text; every completed frame is dispatched synchronously. */
    push(chunk: string): void;
    /** Bytes not yet forming a complete frame (diagnostics/tests). */
    pending(): number;
}

/** Parse one normalized (LF-only) frame body into its event + data. Frames
 *  carrying no data line yield null — spec says they dispatch nothing. */
export function parseSseFrame(frame: string): SseFrame | null {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
        if (line === '' || line.startsWith(':')) continue; // blank / comment
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        // Per the SSE grammar a single leading space after the colon is
        // stripped; `data:x` (no space) is also valid.
        let val = colon === -1 ? '' : line.slice(colon + 1);
        if (val.startsWith(' ')) val = val.slice(1);
        if (field === 'event') event = val;
        else if (field === 'data') dataLines.push(val); // multiple → joined
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
}

export function createSseParser(onFrame: (frame: SseFrame) => void): SseParser {
    // Normalized (LF-only) text not yet forming a full frame.
    let buf = '';
    // A CR that ended the previous chunk: it is either the first half of a
    // CRLF whose LF is still in flight, or a lone-CR line ending. Decided
    // when the next chunk arrives (#414).
    let pendingCR = false;

    return {
        push(chunk: string): void {
            let text = (pendingCR ? '\r' : '') + chunk;
            pendingCR = false;
            if (text.endsWith('\r')) {
                pendingCR = true;
                text = text.slice(0, -1);
            }
            // CRLF → LF first, then any lone CR → LF (both are legal line ends).
            buf += text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

            let idx: number;
            while ((idx = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                const parsed = parseSseFrame(frame);
                if (parsed) onFrame(parsed);
            }
        },
        pending(): number {
            return buf.length + (pendingCR ? 1 : 0);
        },
    };
}
