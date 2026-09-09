import { describe, expect, it } from 'vitest';
import { shouldFollowBottom, type FollowInput } from './chatFollow';

const live: FollowInput = { loaded: true, restoring: false, nearBottom: true, interacting: false };

describe('shouldFollowBottom', () => {
    it('follows only when loaded, not restoring, near the bottom and hands-off', () => {
        expect(shouldFollowBottom(live)).toBe(true);
    });

    it('a reader away from the bottom is never pulled down', () => {
        expect(shouldFollowBottom({ ...live, nearBottom: false })).toBe(false);
    });

    it('a finger on the screen or a fling in progress is never fought, even at the bottom', () => {
        expect(shouldFollowBottom({ ...live, interacting: true })).toBe(false);
    });

    it('a restore in flight is not undone', () => {
        expect(shouldFollowBottom({ ...live, restoring: true })).toBe(false);
    });

    it('before the first layout the list positions itself', () => {
        expect(shouldFollowBottom({ ...live, loaded: false })).toBe(false);
    });

    it('exhaustive: exactly one of the sixteen combinations follows', () => {
        let follows = 0;
        for (const loaded of [true, false]) for (const restoring of [true, false])
            for (const nearBottom of [true, false]) for (const interacting of [true, false]) {
                if (shouldFollowBottom({ loaded, restoring, nearBottom, interacting })) follows++;
            }
        expect(follows).toBe(1);
    });
});
