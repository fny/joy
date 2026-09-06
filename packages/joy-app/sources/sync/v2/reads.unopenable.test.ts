/**
 * #128 — the v2 readers report WHICH sealed rows they could not open
 * (`unopenableSeqs`), not just how many. A backward read walks the relay's
 * descending pages and trims to the newest `limit` renderable rows, so a
 * failure can sit far below the rows it returns; with a bare count the
 * sync recorded a gap over the returned span and blamed rows that opened
 * fine. Real codec (libsodium-wrappers), relay stubbed at fetch.
 */
import { describe, it, expect, beforeAll, vi, afterEach } from 'vitest';
import _sodium from 'libsodium-wrappers';

vi.mock('@/encryption/libsodium.lib', async () => {
    await _sodium.ready;
    return { default: _sodium };
});
vi.mock('./api', () => ({ getV2BaseUrl: () => 'http://relay.test' }));

type Reads = typeof import('./reads');
let v2MessagesAfter: Reads['v2MessagesAfter'];
let v2MessagesBefore: Reads['v2MessagesBefore'];
let sealV2Content: typeof import('./crypto').sealV2Content;

const K2 = new Uint8Array(32).fill(2);
const K3 = new Uint8Array(32).fill(3);

type Event = { id: string; seq: string; kind: string; turnId: string | null; commandId: string | null; createdAt: number; content: { ciphertext: string } };
let events: Event[] = [];
const requests: string[] = [];

/** One `output` row per seq, sealed under `key`. */
function event(seq: number, key: Uint8Array): Event {
    return { id: `e${seq}`, seq: String(seq), kind: 'output', turnId: 't', commandId: null, createdAt: seq, content: { ciphertext: sealV2Content(`row${seq}`, key) } };
}

/** The relay's events endpoint: `after=` pages forward, `before=` returns the newest rows below the bound, ascending. */
function relay(url: string) {
    const u = new URL(url);
    requests.push(u.search);
    const limit = Number(u.searchParams.get('limit'));
    const before = u.searchParams.get('before');
    const eligible = before !== null
        ? events.filter((e) => Number(e.seq) < Number(before))
        : events.filter((e) => Number(e.seq) > Number(u.searchParams.get('after')));
    const page = before !== null ? eligible.slice(-limit) : eligible.slice(0, limit);
    return { ok: true, json: async () => ({ messages: page, hasMore: eligible.length > page.length }) };
}

beforeAll(async () => {
    await _sodium.ready;
    ({ v2MessagesAfter, v2MessagesBefore } = await import('./reads'));
    ({ sealV2Content } = await import('./crypto'));
    vi.stubGlobal('fetch', async (url: string) => relay(url));
    vi.spyOn(console, 'warn').mockImplementation(() => { });
});
afterEach(() => { requests.length = 0; });

const ctx = { base: 'http://relay.test', token: 't', v2SessionId: 'S' };

describe('v2 readers name the rows they could not open (#128)', () => {
    it('a backward page trimmed to the newest 100 reports the one failure far below its cursor, not the returned span', async () => {
        events = Array.from({ length: 200 }, (_, i) => event(i + 1, i === 0 ? K3 : K2));
        const page = await v2MessagesBefore({ ...ctx, key: K2, beforeSeq: 201 });
        expect(page.messages.map((m) => m.seq)).toEqual(Array.from({ length: 100 }, (_, i) => 101 + i));
        expect(page.cursor).toBe(101);
        expect(page.hasMore).toBe(true);
        expect(page.unopenable).toBe(1);
        expect(page.unopenableSeqs).toEqual([1]);
    });

    it('failures across several descending relay pages come back ascending', async () => {
        // 450 seqs, three sealed under another key: the reader walks three
        // 200-row relay pages (newest first) before the log is exhausted.
        events = Array.from({ length: 450 }, (_, i) => event(i + 1, [3, 250, 449].includes(i + 1) ? K3 : K2));
        const page = await v2MessagesBefore({ ...ctx, key: K2, beforeSeq: 451, limit: 500 });
        expect(requests).toEqual(['?before=451&limit=200', '?before=251&limit=200', '?before=51&limit=200']);
        expect(page.messages).toHaveLength(447);
        expect(page.unopenable).toBe(3);
        expect(page.unopenableSeqs).toEqual([3, 250, 449]);
    });

    it('a forward page reports its failures by seq and none when everything opened', async () => {
        events = [event(1, K2), event(2, K3), event(3, K2), event(4, K3)];
        const sealed = await v2MessagesAfter({ ...ctx, key: K2, afterSeq: 0 });
        expect(sealed.messages.map((m) => m.seq)).toEqual([1, 3]);
        expect(sealed.cursor).toBe(4);
        expect(sealed.unopenable).toBe(2);
        expect(sealed.unopenableSeqs).toEqual([2, 4]);

        const clean = await v2MessagesAfter({ ...ctx, key: K3, afterSeq: 3 });
        expect(clean.messages.map((m) => m.seq)).toEqual([4]);
        expect(clean.unopenable).toBe(0);
        expect(clean.unopenableSeqs).toEqual([]);
    });
});
