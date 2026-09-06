import { describe, expect, it } from 'vitest';
import { composeShakeTransforms, shakeKeyframes } from './shakeTransform';

describe('shake transforms (#239)', () => {
    it('starts and ends at rest so no fill is needed', () => {
        const k = shakeKeyframes();
        expect(k[0]).toBe(0);
        expect(k[k.length - 1]).toBe(0);
        expect(k).toEqual([0, 3, -3, 3, -3, 0]);
    });

    it('composes each keyframe with the existing transform', () => {
        expect(composeShakeTransforms('matrix(2, 0, 0, 2, 0, 0)', [0, 3])).toEqual([
            'matrix(2, 0, 0, 2, 0, 0) translateX(0px)',
            'matrix(2, 0, 0, 2, 0, 0) translateX(3px)',
        ]);
    });

    it('uses a bare translate when the element has no transform', () => {
        expect(composeShakeTransforms('none', [3])).toEqual(['translateX(3px)']);
        expect(composeShakeTransforms(null, [-3])).toEqual(['translateX(-3px)']);
    });
});
