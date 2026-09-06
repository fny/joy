/**
 * A reference-counted lease over a shared resource. The first holder installs
 * it, the LAST holder to release removes it — so a consumer unmounting while
 * another still depends on the resource cannot pull it out from under them.
 *
 * Motivating case (#314): two useDemoSession consumers (the demo list and a
 * detail view) both loaded the demo fixtures into storage; unmounting the
 * detail view deleted the session the still-mounted list was rendering, and
 * the list's unchanged `active` flag never re-installed it.
 */
export interface SharedLease {
    /** Current number of holders. */
    readonly holders: number;
    /** Take a hold; the returned function releases it (idempotent). */
    acquire(): () => void;
}

export function createSharedLease(install: () => void, uninstall: () => void): SharedLease {
    let holders = 0;
    return {
        get holders() { return holders; },
        acquire() {
            if (holders++ === 0) install();
            let released = false;
            return () => {
                if (released) return;
                released = true;
                if (--holders === 0) uninstall();
            };
        },
    };
}
