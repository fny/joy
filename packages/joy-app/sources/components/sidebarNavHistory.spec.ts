import { describe, it, expect } from 'vitest';
import { applyNavEntry, applyNavPathname, canNavBack, canNavForward, createNavHistory } from './sidebarNavHistory';

const paths = (h: { stack: { pathname: string }[] }) => h.stack.map((e) => e.pathname);

describe('sidebarNavHistory (pathname fallback)', () => {
    it('#240: the mount effect re-reporting the initial pathname does not enable Back', () => {
        const h0 = createNavHistory('/');
        const h1 = applyNavPathname(h0, '/', null);
        expect(h1).toBe(h0);
        expect(canNavBack(h1)).toBe(false);
    });

    it('#240: a browser Back (popstate) keeps Forward available instead of appending a new entry', () => {
        let h = createNavHistory('/');
        h = applyNavPathname(h, '/settings', null);
        expect(canNavBack(h)).toBe(true);
        h = applyNavPathname(h, '/', 'pop');
        expect(paths(h)).toEqual(['/', '/settings']);
        expect(h.cursor).toBe(0);
        expect(canNavForward(h)).toBe(true);
        h = applyNavPathname(h, '/settings', 'pop');
        expect(h.cursor).toBe(1);
        expect(canNavForward(h)).toBe(false);
    });

    it('sidebar-marked back/forward move the cursor without touching the stack', () => {
        let h = createNavHistory('/');
        h = applyNavPathname(h, '/a', null);
        h = applyNavPathname(h, '/b', null);
        h = applyNavPathname(h, '/a', 'back');
        expect(h.cursor).toBe(1);
        h = applyNavPathname(h, '/b', 'forward');
        expect(h.cursor).toBe(2);
        expect(paths(h)).toEqual(['/', '/a', '/b']);
    });

    it('a fresh navigation truncates forward entries', () => {
        let h = createNavHistory('/');
        h = applyNavPathname(h, '/a', null);
        h = applyNavPathname(h, '/', 'pop');
        h = applyNavPathname(h, '/c', null);
        expect(paths(h)).toEqual(['/', '/c']);
        expect(canNavForward(h)).toBe(false);
    });

    it('a popstate to an unknown entry is treated as a new navigation', () => {
        let h = createNavHistory('/');
        h = applyNavPathname(h, '/elsewhere', 'pop');
        expect(paths(h)).toEqual(['/', '/elsewhere']);
    });
});

describe('sidebarNavHistory keyed on browser entry identity (#240 residual)', () => {
    const e = (key: string, pathname: string) => ({ key, pathname });

    it('a multi-entry browser Back lands on the right entry and keeps Forward', () => {
        let h = createNavHistory('/', 'k0');
        h = applyNavEntry(h, e('k1', '/a'), null);
        h = applyNavEntry(h, e('k2', '/b'), null);
        h = applyNavEntry(h, e('k3', '/c'), null);
        // History menu: jump two entries back at once. Pathname inference
        // used to see "/a" as no neighbour of "/c" and PUSH it.
        h = applyNavEntry(h, e('k1', '/a'), 'pop');
        expect(h.cursor).toBe(1);
        expect(paths(h)).toEqual(['/', '/a', '/b', '/c']);
        expect(canNavForward(h)).toBe(true);
        // ...and forward two at once
        h = applyNavEntry(h, e('k3', '/c'), 'pop');
        expect(h.cursor).toBe(3);
        expect(canNavForward(h)).toBe(false);
    });

    it('a replace to a different pathname stays one entry', () => {
        let h = createNavHistory('/', 'k0');
        h = applyNavEntry(h, e('k1', '/session/1'), null);
        // router.replace: expo-router keeps history.state.id on replaceState
        h = applyNavEntry(h, e('k1', '/session/2'), null);
        expect(paths(h)).toEqual(['/', '/session/2']);
        expect(h.cursor).toBe(1);
        h = applyNavEntry(h, e('k0', '/'), 'pop');
        expect(canNavForward(h)).toBe(true);
    });

    it('query-only changes (same pathname, new entry) are distinct entries', () => {
        let h = createNavHistory('/', 'k0');
        h = applyNavEntry(h, e('k1', '/files'), null);
        h = applyNavEntry(h, e('k2', '/files'), null); // ?path=other
        expect(h.stack).toHaveLength(3);
        h = applyNavEntry(h, e('k1', '/files'), 'pop');
        expect(h.cursor).toBe(1);
        expect(canNavForward(h)).toBe(true);
        expect(canNavBack(h)).toBe(true);
    });

    it('the seed entry adopts the id the first report carries, without a new entry', () => {
        let h = createNavHistory('/');
        h = applyNavEntry(h, e('k0', '/'), null);
        expect(h.stack).toEqual([e('k0', '/')]);
        expect(canNavBack(h)).toBe(false);
    });

    it('a new entry after a Back truncates forward history', () => {
        let h = createNavHistory('/', 'k0');
        h = applyNavEntry(h, e('k1', '/a'), null);
        h = applyNavEntry(h, e('k0', '/'), 'pop');
        h = applyNavEntry(h, e('k2', '/c'), null);
        expect(paths(h)).toEqual(['/', '/c']);
        expect(canNavForward(h)).toBe(false);
    });
});
