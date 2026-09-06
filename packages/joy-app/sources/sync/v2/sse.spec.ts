/**
 * The SSE frame splitter behind connectV2Stream, fed the chunkings fetch can
 * actually produce. The per-chunk CRLF normalization it replaces lost every
 * frame whose terminating CRLF pair straddled a chunk boundary and turned a
 * split `event: hello\r|\n` into a poke with no session id (#414).
 */
import { describe, it, expect } from 'vitest';
import { createSseParser, parseSseFrame, type SseFrame } from './sse';

function collect(chunks: string[]): SseFrame[] {
    const out: SseFrame[] = [];
    const p = createSseParser(f => out.push(f));
    for (const c of chunks) p.push(c);
    return out;
}

describe('createSseParser', () => {
    it('splits LF-only frames and joins multiple data lines', () => {
        const frames = collect(['event: poke\ndata: {"a":1}\ndata: {"b":2}\n\n: comment\ndata:x\n\n']);
        expect(frames).toEqual([
            { event: 'poke', data: '{"a":1}\n{"b":2}' },
            { event: 'message', data: 'x' },
        ]);
    });

    it('CRLF frame delivered whole', () => {
        expect(collect(['event: hello\r\ndata: {}\r\n\r\n'])).toEqual([{ event: 'hello', data: '{}' }]);
    });

    it('#414: a frame terminator CRLF CRLF split between chunks still ends the frame', () => {
        // Every possible cut inside "\r\n\r\n" — the old parser never
        // dispatched any of these and kept the bytes buffered.
        const body = 'event: hello\r\ndata: {"sessions":[]}';
        const tail = '\r\n\r\n';
        for (let cut = 1; cut < tail.length; cut++) {
            const frames = collect([body + tail.slice(0, cut), tail.slice(cut)]);
            expect(frames, `cut at ${cut}`).toEqual([{ event: 'hello', data: '{"sessions":[]}' }]);
        }
    });

    it('#414: an event line split between its CR and LF keeps its name', () => {
        const frames = collect(['event: hello\r', '\ndata: {}\r\n\r\n']);
        expect(frames).toEqual([{ event: 'hello', data: '{}' }]);
    });

    it('does not dispatch a frame whose closing LF has not arrived, then does', () => {
        const out: SseFrame[] = [];
        const p = createSseParser(f => out.push(f));
        p.push('data: 1\r\n\r');
        expect(out).toEqual([]);
        expect(p.pending()).toBeGreaterThan(0);
        p.push('\n');
        expect(out).toEqual([{ event: 'message', data: '1' }]);
        expect(p.pending()).toBe(0);
    });

    it('accepts lone-CR line endings and single-character chunks', () => {
        const text = 'event: ephemeral\rdata: {"t":1}\r\rdata: 2\n\n';
        const frames = collect(text.split(''));
        expect(frames).toEqual([
            { event: 'ephemeral', data: '{"t":1}' },
            { event: 'message', data: '2' },
        ]);
    });

    it('does not grow the buffer across many split CRLF frames', () => {
        const out: SseFrame[] = [];
        const p = createSseParser(f => out.push(f));
        for (let i = 0; i < 200; i++) {
            p.push(`data: ${i}\r\n\r`);
            p.push('\n');
        }
        expect(out).toHaveLength(200);
        expect(p.pending()).toBe(0);
    });
});

describe('parseSseFrame', () => {
    it('yields null for a frame with no data', () => {
        expect(parseSseFrame('event: hello\n: keepalive')).toBeNull();
    });
    it('strips exactly one leading space after the colon', () => {
        expect(parseSseFrame('data:  two')).toEqual({ event: 'message', data: ' two' });
    });
});
