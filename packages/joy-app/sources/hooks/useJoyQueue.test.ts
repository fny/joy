import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

// Silence React's "not configured to support act" warning in the node env.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tunnelJson = vi.fn();
let ctx: Record<string, unknown> | null = { relayUrl: 'r', accountToken: 't', machineKey: new Uint8Array(32), machineId: 'm' };
vi.mock('@/sync/v2/tunnel', () => ({ tunnelJson: (...args: unknown[]) => tunnelJson(...args) }));
vi.mock('@/sync/sync', () => ({ sync: { machineCtxFor: () => ctx } }));

import { queueMutationError, useJoyQueue } from './useJoyQueue';

describe('queueMutationError (#321)', () => {
    it('accepts only an explicit 2xx + ok:true', () => {
        expect(queueMutationError(200, { ok: true })).toBeNull();
        expect(queueMutationError(204, { ok: true })).toBeNull();
    });
    it('reports a daemon error string', () => {
        expect(queueMutationError(404, { error: 'session_not_found' })).toBe('session_not_found');
    });
    it('reports an empty/non-JSON failure body by status', () => {
        expect(queueMutationError(500, null)).toBe('HTTP 500');
        expect(queueMutationError(409, null)).toBe('HTTP 409');
    });
    it('treats ok:false as a failure even on 200 (qid no longer queued)', () => {
        expect(queueMutationError(200, { ok: false })).toBe('queue item no longer queued');
    });
    it('does not trust a 2xx without an ok flag', () => {
        expect(queueMutationError(200, {})).toBe('HTTP 200');
        expect(queueMutationError(200, null)).toBe('HTTP 200');
    });
});

async function mountQueue() {
    let latest: ReturnType<typeof useJoyQueue> | null = null;
    function Host() { latest = useJoyQueue('m', 's', null); return null; }
    let root!: ReturnType<typeof create>;
    await act(async () => { root = create(React.createElement(Host)); });
    return { queue: () => latest!, unmount: () => act(async () => { root.unmount(); }) };
}

describe('useJoyQueue mutations (#321)', () => {
    beforeEach(() => { tunnelJson.mockReset(); ctx = { relayUrl: 'r', accountToken: 't', machineKey: new Uint8Array(32), machineId: 'm' }; });

    it('resolves when the daemon acknowledges', async () => {
        tunnelJson.mockResolvedValue({ status: 200, data: { ok: true, queue: [] } });
        const h = await mountQueue();
        await expect(h.queue().cancel('q1')).resolves.toBeUndefined();
        expect(tunnelJson).toHaveBeenCalledWith(expect.objectContaining({ method: 'DELETE', path: '/v2/sessions/s/queue/q1' }));
        await h.unmount();
    });

    it('rejects on a non-success daemon status (409) instead of resolving', async () => {
        tunnelJson.mockResolvedValue({ status: 409, data: null });
        const h = await mountQueue();
        await expect(h.queue().edit('q1', 'new text')).rejects.toThrow('HTTP 409');
        await h.unmount();
    });

    it('rejects when the tunnel request itself fails', async () => {
        tunnelJson.mockRejectedValue(new Error('network down'));
        const h = await mountQueue();
        await expect(h.queue().cancel('q1')).rejects.toThrow('network down');
        await h.unmount();
    });

    it('rejects when there is no machine context (was a silent no-op)', async () => {
        ctx = null;
        const h = await mountQueue();
        await expect(h.queue().cancel('q1')).rejects.toThrow(/no machine context/);
        expect(tunnelJson).not.toHaveBeenCalled();
        await h.unmount();
    });
});
