/**
 * Outbox tests — comm-layer-spec §10.
 *
 * Uses a fake RelayClient (no network). Verifies:
 *  - enqueue → flush appends one record per entry and marks them acked
 *  - persistence: a new Outbox instance loaded against the same on-disk
 *    file resumes unacked entries
 *  - "crash" mid-flush: aborting the signal stops the flush; the next
 *    instance picks up exactly where we left off
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Outbox } from './outbox';
import type { AppendResult, RawMessage, ReadResult, RelayClient } from './relayClient';
import type { Envelope } from '../protocol/envelope';

class FakeRelay {
    public appended: { sessionId: string; localId: string; size: number; seq: number }[] = [];
    public failNext = 0;
    private seq = 0;
    async append(sessionId: string, encrypted: Uint8Array, localId: string): Promise<AppendResult> {
        if (this.failNext > 0) {
            this.failNext -= 1;
            throw new Error('synthetic network error');
        }
        this.seq += 1;
        this.appended.push({ sessionId, localId, size: encrypted.byteLength, seq: this.seq });
        return { seq: this.seq, id: 'srv-' + this.seq };
    }
    async readSince(_s: string, _a: number, _l = 100): Promise<ReadResult> {
        return { messages: [] as RawMessage[], hasMore: false };
    }
    async readBefore(_s: string, _b: number, _l = 100): Promise<ReadResult> {
        return { messages: [] as RawMessage[], hasMore: false };
    }
    connect(): void { /* no-op */ }
    close(): void { /* no-op */ }
    subscribe(_s: string, _cb: () => void): () => void { return () => undefined; }
}

function mkSessionDir(): { sessionId: string; home: string } {
    const home = mkdtempSync(join(tmpdir(), 'joy-test-'));
    process.env.JOY_HOME = home;
    return { sessionId: 's-' + randomUUID(), home };
}

function mkEnvelope(type: string, payload: unknown): Envelope {
    return {
        eventId: randomUUID(),
        type,
        v: 1,
        vmin: null,
        sessionId: 's',
        turnId: null,
        by: 't',
        ts: Date.now(),
        payload,
    };
}

afterEach(() => {
    if (process.env.JOY_HOME?.includes('joy-test-')) {
        try { rmSync(process.env.JOY_HOME, { recursive: true, force: true }); } catch { /* ok */ }
    }
    delete process.env.JOY_HOME;
});

describe('Outbox', () => {
    it('enqueue → flush appends and acks each entry once', async () => {
        const { sessionId } = mkSessionDir();
        const relay = new FakeRelay();
        const ctl = new AbortController();
        const acked: string[] = [];
        const ob = new Outbox({
            sessionId,
            relay: relay as unknown as RelayClient,
            sessionKey: new Uint8Array(32),
            variant: 'legacy',
            onAck: (e) => acked.push(e.eventId),
            signal: ctl.signal,
        });
        const e1 = mkEnvelope('mode-change', { model: 'opus' });
        const e2 = mkEnvelope('mode-change', { permissionMode: 'auto' });
        ob.enqueue(e1);
        ob.enqueue(e2);
        await ob.flush();
        expect(relay.appended.length).toBe(2);
        expect(acked).toEqual([e1.eventId, e2.eventId]);
        expect(ob.pendingCount()).toBe(0);
    });

    it('persists unacked entries across restarts', async () => {
        const { sessionId } = mkSessionDir();
        const relay1 = new FakeRelay();
        relay1.failNext = 999; // never succeeds
        const ctl1 = new AbortController();
        const ob1 = new Outbox({
            sessionId,
            relay: relay1 as unknown as RelayClient,
            sessionKey: new Uint8Array(32),
            variant: 'legacy',
            signal: ctl1.signal,
        });
        const e = mkEnvelope('mode-change', { model: 'opus' });
        ob1.enqueue(e);
        // Let the first attempt fail and a retry get scheduled, then abort.
        await new Promise((r) => setTimeout(r, 50));
        ctl1.abort();
        await new Promise((r) => setTimeout(r, 10));
        expect(relay1.appended.length).toBe(0);

        // Restart: new Outbox on the same path, working relay this time.
        const relay2 = new FakeRelay();
        const ctl2 = new AbortController();
        const acked: string[] = [];
        const ob2 = new Outbox({
            sessionId,
            relay: relay2 as unknown as RelayClient,
            sessionKey: new Uint8Array(32),
            variant: 'legacy',
            onAck: (x) => acked.push(x.eventId),
            signal: ctl2.signal,
        });
        expect(ob2.pendingCount()).toBe(1);
        await ob2.flush();
        expect(relay2.appended.length).toBe(1);
        expect(acked).toEqual([e.eventId]);
    });
});
