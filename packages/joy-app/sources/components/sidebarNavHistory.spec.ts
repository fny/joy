import { describe, it, expect } from 'vitest';
import { applyNavPathname, canNavBack, canNavForward, createNavHistory } from './sidebarNavHistory';

describe('sidebarNavHistory', () => {
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
        expect(h.stack).toEqual(['/', '/settings']);
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
        expect(h.stack).toEqual(['/', '/a', '/b']);
    });

    it('a fresh navigation truncates forward entries', () => {
        let h = createNavHistory('/');
        h = applyNavPathname(h, '/a', null);
        h = applyNavPathname(h, '/', 'pop');
        h = applyNavPathname(h, '/c', null);
        expect(h.stack).toEqual(['/', '/c']);
        expect(canNavForward(h)).toBe(false);
    });

    it('a popstate to an unknown entry is treated as a new navigation', () => {
        let h = createNavHistory('/');
        h = applyNavPathname(h, '/elsewhere', 'pop');
        expect(h.stack).toEqual(['/', '/elsewhere']);
    });
});
