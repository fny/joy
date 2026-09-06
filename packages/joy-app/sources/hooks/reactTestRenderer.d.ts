// Minimal ambient typing for react-test-renderer 19, which ships no types
// and has no @types package at this version. Only what the hook tests in
// this folder use. (A fuller shim lives on a pending branch under
// sources/testing/; ambient module declarations merge, so both can coexist —
// delete this one once that lands.)
declare module 'react-test-renderer' {
    import type { ReactElement } from 'react';
    export interface ReactTestRenderer {
        unmount(): void;
        update(element: ReactElement): void;
    }
    export function create(element: ReactElement): ReactTestRenderer;
    export function act(callback: () => void | Promise<void>): Promise<void>;
}
