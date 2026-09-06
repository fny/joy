import React, { useEffect, useRef } from 'react';
import { View, Animated } from 'react-native';
import { createScope } from '@/utils/scope';

interface VoiceBarsProps {
    isActive: boolean;
    color?: string;
    size?: 'small' | 'medium';
}

export const VoiceBars: React.FC<VoiceBarsProps> = ({
    isActive,
    color = '#fff',
    size = 'small'
}) => {
    const bar1 = useRef(new Animated.Value(0.3)).current;
    const bar2 = useRef(new Animated.Value(0.5)).current;
    const bar3 = useRef(new Animated.Value(0.4)).current;

    useEffect(() => {
        // Every loop (and the reset animation) is owned by this effect run
        // and stopped by its cleanup. stopAnimation() on the VALUES was not
        // enough: a loop still inside its Animated.delay is not touching the
        // value yet, so it survived deactivation and unmount and restarted the
        // bars 1.3s later (#245).
        const scope = createScope();
        if (isActive) {
            // Start animations with different timings for each bar
            const animate = (bar: Animated.Value, duration: number, delay: number = 0) => {
                const loop = Animated.loop(
                    Animated.sequence([
                        Animated.delay(delay),
                        Animated.timing(bar, {
                            toValue: 1,
                            duration: duration,
                            useNativeDriver: true,
                        }),
                        Animated.timing(bar, {
                            toValue: 0.3,
                            duration: duration,
                            useNativeDriver: true,
                        }),
                    ])
                );
                loop.start();
                scope.defer(() => loop.stop());
            };

            animate(bar1, 300, 0);
            animate(bar2, 350, 100);
            animate(bar3, 400, 200);
        } else {
            // Reset to static state
            const reset = Animated.parallel([
                Animated.timing(bar1, { toValue: 0.3, duration: 200, useNativeDriver: true }),
                Animated.timing(bar2, { toValue: 0.3, duration: 200, useNativeDriver: true }),
                Animated.timing(bar3, { toValue: 0.3, duration: 200, useNativeDriver: true }),
            ]);
            reset.start();
            scope.defer(() => reset.stop());
        }
        return () => scope.cancel();
    }, [isActive, bar1, bar2, bar3]);

    const barWidth = size === 'small' ? 2 : 3;
    const barHeight = size === 'small' ? 12 : 16;
    const gap = size === 'small' ? 1.5 : 2;

    return (
        <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap,
            height: barHeight
        }}>
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar1 }],
                overflow: 'hidden',
            }} />
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar2 }],
                overflow: 'hidden',
            }} />
            <Animated.View style={{
                width: barWidth,
                height: barHeight,
                backgroundColor: color,
                borderRadius: barWidth,
                transform: [{ scaleY: bar3 }],
                overflow: 'hidden',
            }} />
        </View>
    );
};
