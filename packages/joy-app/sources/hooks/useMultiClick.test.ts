/**
 * useMultiClick's reset timer belongs to the owning component: once the view
 * unmounts, an obsolete click sequence must not call onClickCountChange(0)
 * (#324). While mounted, the window still resets and the Nth click fires.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { useMultiClick } from './useMultiClick';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: ReactTestRenderer | null = null;

async function mount(requiredClicks: number, resetTimeout: number) {
    const fired = vi.fn();
    const counts = vi.fn<(count: number) => void>();
    let click: () => void = () => {};
    function Host() {
        click = useMultiClick(fired, { requiredClicks, resetTimeout, onClickCountChange: counts });
        return null;
    }
    await act(async () => { renderer = create(React.createElement(Host)); });
    return {
        fired,
        counts: () => counts.mock.calls.map((c) => c[0]),
        click: () => act(async () => { click(); }),
        unmount: async () => { await act(async () => { renderer!.unmount(); }); renderer = null; },
    };
}

describe('useMultiClick — the reset timer dies with its component (#324)', () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(async () => {
        if (renderer) await act(async () => { renderer!.unmount(); });
        renderer = null;
        vi.useRealTimers();
    });

    it('unmounting before resetTimeout: the consumer is never told the count reset to 0', async () => {
        const h = await mount(3, 2000);
        await h.click();
        expect(h.counts()).toEqual([1]);

        await h.unmount();
        await act(async () => { vi.advanceTimersByTime(10_000); });

        expect(h.counts()).toEqual([1]);
        expect(h.fired).not.toHaveBeenCalled();
    });

    it('while mounted the window resets after resetTimeout and the count starts over', async () => {
        const h = await mount(3, 2000);
        await h.click();
        await h.click();
        expect(h.counts()).toEqual([1, 2]);
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(h.counts()).toEqual([1, 2, 0]);

        await h.click();
        expect(h.counts()).toEqual([1, 2, 0, 1]);
        expect(h.fired).not.toHaveBeenCalled();
    });

    it('the Nth click within the window fires the callback once and resets without a stray timer', async () => {
        const h = await mount(3, 2000);
        await h.click();
        await act(async () => { vi.advanceTimersByTime(1500); });
        await h.click();
        await act(async () => { vi.advanceTimersByTime(1500); });
        await h.click();
        expect(h.fired).toHaveBeenCalledTimes(1);
        expect(h.counts()).toEqual([1, 2, 3, 0]);

        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(h.counts()).toEqual([1, 2, 3, 0]);
    });
});
