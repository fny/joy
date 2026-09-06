import { describe, expect, it, vi } from 'vitest';
import { createSharedLease } from './sharedLease';

describe('shared lease (#314)', () => {
    it('installs on the first hold and uninstalls only when the last hold is released', () => {
        const install = vi.fn();
        const uninstall = vi.fn();
        const lease = createSharedLease(install, uninstall);

        const releaseList = lease.acquire();   // demo list mounts
        const releaseDetail = lease.acquire(); // detail view mounts
        expect(install).toHaveBeenCalledTimes(1);
        expect(lease.holders).toBe(2);

        releaseDetail();                       // detail view unmounts
        expect(uninstall).not.toHaveBeenCalled(); // the list still renders the fixtures
        expect(lease.holders).toBe(1);

        releaseList();
        expect(uninstall).toHaveBeenCalledTimes(1);
        expect(lease.holders).toBe(0);
    });

    it('re-installs when a new hold arrives after everything was released', () => {
        const install = vi.fn();
        const uninstall = vi.fn();
        const lease = createSharedLease(install, uninstall);
        lease.acquire()();
        lease.acquire();
        expect(install).toHaveBeenCalledTimes(2);
        expect(uninstall).toHaveBeenCalledTimes(1);
    });

    it('releasing the same hold twice does not double-count', () => {
        const uninstall = vi.fn();
        const lease = createSharedLease(() => {}, uninstall);
        const a = lease.acquire();
        lease.acquire();
        a();
        a();
        expect(uninstall).not.toHaveBeenCalled();
        expect(lease.holders).toBe(1);
    });
});
