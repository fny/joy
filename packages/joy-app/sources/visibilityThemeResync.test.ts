import { describe, expect, it } from 'vitest';
import { planVisibilityResync } from './visibilityThemeResync';

describe('planVisibilityResync (#420)', () => {
    it('follows the OS scheme only while the current preference is adaptive', () => {
        expect(planVisibilityResync('adaptive', 'dark')).toEqual({ theme: 'dark' });
        expect(planVisibilityResync('adaptive', 'light')).toEqual({ theme: 'light' });
        expect(planVisibilityResync('adaptive', null)).toEqual({ theme: 'light' });
    });

    // A saved fixed-Light preference used to become active Dark (with adaptive
    // themes re-enabled) when the OS was dark and the tab was revisited.
    it('leaves a fixed preference alone regardless of the OS scheme', () => {
        expect(planVisibilityResync('light', 'dark')).toBeNull();
        expect(planVisibilityResync('dark', 'light')).toBeNull();
    });
});
