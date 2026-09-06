import { describe, expect, it } from 'vitest';
import { NATIVE_MERMAID_INITIAL_HEIGHT, NATIVE_MERMAID_MAX_HEIGHT, nativeMermaidViewport } from './mermaidViewport';

describe('nativeMermaidViewport (#259)', () => {
    it('scrolls at the initial height until the document reports one', () => {
        expect(nativeMermaidViewport(null)).toEqual({ height: NATIVE_MERMAID_INITIAL_HEIGHT, scrollEnabled: true });
        expect(nativeMermaidViewport(0)).toEqual({ height: NATIVE_MERMAID_INITIAL_HEIGHT, scrollEnabled: true });
    });

    it('a diagram that fits gets its full height and nothing to scroll', () => {
        expect(nativeMermaidViewport(900)).toEqual({ height: 900, scrollEnabled: false });
        expect(nativeMermaidViewport(120)).toEqual({ height: NATIVE_MERMAID_INITIAL_HEIGHT, scrollEnabled: false });
    });

    it('a capped diagram keeps scrolling so its lower part stays reachable', () => {
        expect(nativeMermaidViewport(9000)).toEqual({ height: NATIVE_MERMAID_MAX_HEIGHT, scrollEnabled: true });
        expect(nativeMermaidViewport(NATIVE_MERMAID_MAX_HEIGHT)).toEqual({ height: NATIVE_MERMAID_MAX_HEIGHT, scrollEnabled: false });
    });
});
