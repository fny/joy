import * as React from 'react';
import { View, ViewProps } from 'react-native';
import { composeShakeTransforms, shakeKeyframes } from './shakeTransform';

export type ShakeInstance = {
    shake: () => void;
}

export const Shaker = React.memo(React.forwardRef<ShakeInstance, ViewProps>((props, ref) => {
    const baseRef = React.useRef<View>(null);
    const runningRef = React.useRef<Animation | null>(null);
    React.useImperativeHandle(ref, () => ({
        shake: () => {
            const shakeElement = baseRef.current as unknown as HTMLDivElement | null;
            if (!shakeElement || typeof shakeElement.animate !== 'function') return;
            // A shake still running is cancelled first, so its snapshot of the
            // base transform cannot compound with the new one.
            runningRef.current?.cancel();
            // Compose with the element's OWN transform and never fill forwards:
            // the old animation replaced the transform and left translateX(0px)
            // applied after completion, so a scaled/rotated view lost its
            // transform for good after one shake (#239).
            const base = typeof getComputedStyle === 'function' ? getComputedStyle(shakeElement).transform : 'none';
            const offsets = shakeKeyframes();
            const duration = 300;
            const frames = composeShakeTransforms(base, offsets).map((transform) => ({
                transform,
                easing: 'linear',
            }));
            const animation = shakeElement.animate(frames, {
                duration: duration,
                iterations: 1,
                fill: 'none',
            });
            runningRef.current = animation;
            // Remove the finished animation so nothing keeps overriding the style.
            animation.onfinish = () => {
                if (runningRef.current === animation) runningRef.current = null;
                animation.cancel();
            };
        }
    }));

    return (
        <View ref={baseRef} {...props} />
    );
}));
