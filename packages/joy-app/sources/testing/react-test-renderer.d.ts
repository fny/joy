/**
 * Minimal typings for react-test-renderer (installed without @types) — just
 * the surface the vitest hook/provider specs use. Tests run in the node
 * environment, so this deprecated renderer is the only way to execute React
 * hooks and providers without a DOM.
 */
declare module 'react-test-renderer' {
    import type { ReactElement } from 'react';

    export interface ReactTestInstance {
        type: string | ((props: unknown) => unknown);
        props: Record<string, unknown>;
        children: Array<ReactTestInstance | string>;
        findAllByType(type: string | ((props: never) => unknown)): ReactTestInstance[];
        findByType(type: string | ((props: never) => unknown)): ReactTestInstance;
    }

    export interface ReactTestRenderer {
        root: ReactTestInstance;
        update(element: ReactElement): void;
        unmount(): void;
        toJSON(): unknown;
    }

    export function create(element: ReactElement): ReactTestRenderer;
    export function act(callback: () => void | Promise<void>): Promise<void>;

    const TestRenderer: {
        create: typeof create;
        act: typeof act;
    };
    export default TestRenderer;
}
