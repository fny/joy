import * as React from 'react';
import { Platform, ScrollView, ScrollViewProps } from 'react-native';
import { normalizeWheelDelta } from './wheelDelta';

// Pixel size of one wheel "line" (deltaMode 1). Browsers that expose line
// deltas do not tell us the line height; 16px is the common convention.
const WHEEL_LINE_PX = 16;

// Gesture-locked horizontal wheel scroll.
//
// The first wheel event of a trackpad gesture decides the axis: if horizontal
// movement clearly dominates (|deltaX| > |deltaY| * 2, min 3px) we lock to
// horizontal and drive scrollLeft ourselves; otherwise we lock to vertical and
// let every subsequent event pass through to the page. The lock resets after
// 150ms of idle (gesture ended). This avoids the two failure modes of pure
// per-event detection: slow vertical scrolls leaking tiny deltaX that gets
// misclassified, and fast diagonal swipes flickering between axes.
//
// Shift + wheel always converts vertical to horizontal (mouse wheel users).
// At scroll boundaries the event passes through so the page can scroll.
function useHorizontalWheelScroll() {
    const ref = React.useRef<ScrollView>(null);
    React.useEffect(() => {
        if (Platform.OS !== 'web' || !ref.current) return;
        const node = (ref.current as any)?.getScrollableNode?.() ?? (ref.current as any);
        if (!node || !node.addEventListener) return;

        let gestureAxis: 'h' | 'v' | null = null;
        let gestureTimer = 0;

        const handler = (e: WheelEvent) => {
            const el = node as HTMLElement;
            const maxScroll = el.scrollWidth - el.clientWidth;
            if (maxScroll <= 0) return;

            // Normalize BEFORE axis detection and scrolling: line/page-mode
            // wheels report lines/pages, not pixels — read raw, a Shift+wheel
            // notch moved three pixels instead of three lines (#223).
            const { deltaX, deltaY } = normalizeWheelDelta(e.deltaX, e.deltaY, e.deltaMode, WHEEL_LINE_PX, el.clientWidth || WHEEL_LINE_PX);

            // Shift + wheel: convert vertical wheel to horizontal scroll.
            if (e.shiftKey && deltaY !== 0) {
                e.preventDefault();
                e.stopPropagation();
                el.scrollLeft += deltaY;
                return;
            }

            // Reset gesture lock after 150ms idle.
            window.clearTimeout(gestureTimer);
            gestureTimer = window.setTimeout(() => { gestureAxis = null; }, 150);

            // Decide axis on the first event of the gesture.
            if (gestureAxis === null) {
                const absX = Math.abs(deltaX);
                const absY = Math.abs(deltaY);
                gestureAxis = (absX > absY * 2 && absX > 3) ? 'h' : 'v';
            }

            if (gestureAxis === 'v') return;

            // Horizontal-locked: scroll the element, unless at boundary.
            const atStart = el.scrollLeft <= 0 && deltaX < 0;
            const atEnd = el.scrollLeft >= maxScroll - 1 && deltaX > 0;
            if (atStart || atEnd) return;

            e.preventDefault();
            e.stopPropagation();
            el.scrollLeft += deltaX;
        };
        node.addEventListener('wheel', handler, { passive: false });
        return () => {
            node.removeEventListener('wheel', handler);
            window.clearTimeout(gestureTimer);
        };
    }, []);
    return ref;
}

type Props = Omit<ScrollViewProps, 'horizontal'>;

export function HorizontalScrollView(props: Props) {
    const {
        showsHorizontalScrollIndicator = true,
        nestedScrollEnabled = true,
        ...rest
    } = props;
    const ref = useHorizontalWheelScroll();
    return (
        <ScrollView
            ref={ref}
            horizontal
            showsHorizontalScrollIndicator={showsHorizontalScrollIndicator}
            nestedScrollEnabled={nestedScrollEnabled}
            {...rest}
        />
    );
}
