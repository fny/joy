import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Alert: { alert: vi.fn(), prompt: vi.fn() } }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/utils/guardAsync', () => ({ guarded: (f: unknown) => f, alertError: () => () => {} }));

// The real dialogs pull in unistyles/RN views; a stub exposes the props the
// provider hands them so the tests can drive onClose/onConfirm directly.
const { stub } = vi.hoisted(() => ({
    stub: (kind: string) => (props: Record<string, unknown>) =>
        React.createElement('dialog-stub', { kind, id: (props.config as { id: string }).id, active: props.active, onClose: props.onClose, onConfirm: props.onConfirm }),
}));
vi.mock('./components/WebAlertModal', () => ({ WebAlertModal: stub('alert') }));
vi.mock('./components/WebPromptModal', () => ({ WebPromptModal: stub('prompt') }));
vi.mock('./components/CustomModal', () => ({ CustomModal: stub('custom') }));

import { ModalProvider } from './ModalProvider';
import { Modal } from './ModalManager';

type Dialog = { props: { kind: string; id: string; active: boolean; onClose: () => void; onConfirm?: (v: unknown) => void } };

let renderer: ReactTestRenderer | null = null;
const dialogs = () => renderer!.root.findAllByType('dialog-stub' as never) as unknown as Dialog[];

async function mount(children: React.ReactNode = null) {
    await act(async () => {
        renderer = TestRenderer.create(React.createElement(ModalProvider, null, children));
    });
}

describe('ModalProvider', () => {
    beforeEach(() => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(async () => {
        if (renderer) await act(async () => { renderer!.unmount(); });
        renderer = null;
        await Promise.resolve();
    });

    it('#100: a confirm closed via onRequestClose resolves false instead of hanging', async () => {
        await mount();
        let p!: Promise<boolean>;
        await act(async () => { p = Modal.confirm('Delete?'); });
        expect(dialogs()).toHaveLength(1);
        await act(async () => { dialogs()[0].props.onClose(); });
        expect(await p).toBe(false);
        expect(dialogs()).toHaveLength(0);
    });

    it('#334: hideAll while a prompt waits settles it with null and removes the dialog', async () => {
        await mount();
        let p!: Promise<string | null>;
        await act(async () => { p = Modal.prompt('Name'); });
        expect(dialogs()).toHaveLength(1);
        await act(async () => { Modal.hideAll(); });
        expect(await p).toBeNull();
        expect(dialogs()).toHaveLength(0);
        expect(Modal.pendingCount()).toBe(0);
    });

    it('#335: a dialog requested from a descendant mount effect is shown, not dropped', async () => {
        let p!: Promise<boolean>;
        function Child() {
            React.useEffect(() => { p = Modal.confirm('On mount'); }, []);
            return null;
        }
        await mount(React.createElement(Child));
        expect(dialogs()).toHaveLength(1);
        await act(async () => { dialogs()[0].props.onConfirm!(true); });
        expect(await p).toBe(true);
    });

    it('#336: a request made after the provider unmounted reaches the replacement provider', async () => {
        await mount();
        await act(async () => { renderer!.unmount(); });
        renderer = null;
        let p!: Promise<boolean>;
        await act(async () => { p = Modal.confirm('Between providers'); });
        await mount();
        expect(dialogs()).toHaveLength(1);
        await act(async () => { dialogs()[0].props.onConfirm!(true); });
        expect(await p).toBe(true);
    });

    it('#336: dialogs open when the provider unmounts settle as cancelled', async () => {
        await mount();
        let p!: Promise<string | null>;
        await act(async () => { p = Modal.prompt('Lost'); });
        await act(async () => { renderer!.unmount(); });
        renderer = null;
        expect(await p).toBeNull();
    });

    it('only the top-most stacked dialog is active; the one beneath stays mounted with its own identity (#332/#333)', async () => {
        await mount();
        let a!: Promise<string | null>;
        let b!: Promise<string | null>;
        await act(async () => { a = Modal.prompt('A'); });
        await act(async () => { b = Modal.prompt('B', undefined, { defaultValue: 'default B' }); });
        const stack = dialogs();
        expect(stack).toHaveLength(2);
        expect(stack[0].props.id).not.toBe(stack[1].props.id);
        expect(stack[0].props.active).toBe(false);
        expect(stack[1].props.active).toBe(true);
        await act(async () => { stack[1].props.onConfirm!('typed B'); });
        expect(await b).toBe('typed B');
        expect(dialogs()[0].props.active).toBe(true);
        await act(async () => { dialogs()[0].props.onClose(); });
        expect(await a).toBeNull();
    });
});
