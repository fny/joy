// Native Mermaid viewport. The WebView reports its document height and the
// native side sizes the viewport to it. The size is clamped so a runaway
// document cannot grow the chat without bound — but a clamped diagram is
// taller than its viewport, so the WebView must keep scrolling: sizing a
// 9000px diagram to 4000px with scrolling off hid everything below (#259).

/** Height before the document has reported one; also the minimum. */
export const NATIVE_MERMAID_INITIAL_HEIGHT = 200;

/** Ceiling on the viewport height; taller documents scroll inside it. */
export const NATIVE_MERMAID_MAX_HEIGHT = 4000;

export type NativeMermaidViewport = { height: number; scrollEnabled: boolean };

/**
 * Viewport for the document height the WebView reported (null: nothing
 * reported yet — the viewport may be too short, so it scrolls as a fallback).
 */
export function nativeMermaidViewport(reportedHeight: number | null): NativeMermaidViewport {
    if (reportedHeight === null || !Number.isFinite(reportedHeight) || reportedHeight <= 0) {
        return { height: NATIVE_MERMAID_INITIAL_HEIGHT, scrollEnabled: true };
    }
    const wanted = Math.round(reportedHeight);
    const height = Math.min(Math.max(wanted, NATIVE_MERMAID_INITIAL_HEIGHT), NATIVE_MERMAID_MAX_HEIGHT);
    return { height, scrollEnabled: wanted > height };
}
