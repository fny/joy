import { describe, it, expect, vi, beforeEach } from 'vitest';

const { platform, alertMock } = vi.hoisted(() => ({
    platform: { OS: 'web' as string },
    alertMock: { alert: vi.fn(), prompt: vi.fn() },
}));
vi.mock('react-native', () => ({ Platform: platform, Alert: alertMock }));
vi.mock('@/text', () => ({ t: (k: string) => k }));
vi.mock('@/utils/guardAsync', () => ({ guarded: (f: unknown) => f, alertError: () => () => {} }));

import { Modal, type ShowModalFn } from './ModalManager';

function fakeProvider() {
    const shown: Array<{ id: string; config: { type: string } }> = [];
    const show: ShowModalFn = (id, config) => { shown.push({ id, config: config as { type: string } }); };
    const hide = vi.fn();
    const hideAll = vi.fn();
    const owner = {};
    return { shown, show, hide, hideAll, owner };
}

const settled = async <T,>(p: Promise<T>): Promise<T | 'pending'> => {
    let out: T | 'pending' = 'pending';
    p.then((v) => { out = v; });
    await Promise.resolve();
    await Promise.resolve();
    return out;
};

describe('ModalManager', () => {
    beforeEach(() => {
        platform.OS = 'web';
        Modal.cancelAllPending();
        // Detach whatever the previous test registered.
        (Modal as unknown as { owner: object | null; showModalFn: unknown; hideModalFn: unknown; hideAllModalsFn: unknown }).owner = null;
        (Modal as unknown as { showModalFn: unknown }).showModalFn = null;
        (Modal as unknown as { hideModalFn: unknown }).hideModalFn = null;
        (Modal as unknown as { hideAllModalsFn: unknown }).hideAllModalsFn = null;
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    it('#335: a confirm requested before the provider registers is queued, not cancelled, and replays on registration', async () => {
        const p = Modal.confirm('Title');
        expect(await settled(p)).toBe('pending');
        const prov = fakeProvider();
        Modal.setFunctions(prov.owner, prov.show, prov.hide, prov.hideAll);
        expect(prov.shown).toHaveLength(1);
        expect(prov.shown[0].config.type).toBe('confirm');
        Modal.resolveConfirm(prov.shown[0].id, true);
        expect(await p).toBe(true);
    });

    it('#334: hide(id) and hideAll settle a waiting prompt with null and drop its resolver', async () => {
        const prov = fakeProvider();
        Modal.setFunctions(prov.owner, prov.show, prov.hide, prov.hideAll);
        const a = Modal.prompt('A');
        Modal.hide(prov.shown[0].id);
        expect(await a).toBeNull();
        expect(prov.hide).toHaveBeenCalledWith(prov.shown[0].id);

        const b = Modal.prompt('B');
        const c = Modal.confirm('C');
        expect(Modal.pendingCount()).toBe(2);
        Modal.hideAll();
        expect(await b).toBeNull();
        expect(await c).toBe(false);
        expect(Modal.pendingCount()).toBe(0);
        expect(prov.hideAll).toHaveBeenCalled();
    });

    it('#100: cancelPending never overrides an answer that was already given', async () => {
        const prov = fakeProvider();
        Modal.setFunctions(prov.owner, prov.show, prov.hide, prov.hideAll);
        const p = Modal.confirm('Delete?');
        const id = prov.shown[0].id;
        Modal.resolveConfirm(id, true);
        Modal.cancelPending(id);
        expect(await p).toBe(true);
    });

    it('#336: an unmounted provider cannot be reached; its pending dialogs settle; a stale owner cannot unregister the current one', async () => {
        const first = fakeProvider();
        Modal.setFunctions(first.owner, first.show, first.hide, first.hideAll);
        const hanging = Modal.prompt('hang');
        Modal.clearFunctions(first.owner);
        // Requests made in the gap are parked, not dispatched to the dead instance.
        const gap = Modal.confirm('gap');
        expect(first.shown).toHaveLength(1);
        expect(await hanging).toBeNull();
        expect(await settled(gap)).toBe('pending');

        const second = fakeProvider();
        Modal.setFunctions(second.owner, second.show, second.hide, second.hideAll);
        expect(second.shown.map((s) => s.config.type)).toEqual(['confirm']);
        // The OLD provider's late cleanup must not tear down the new one.
        Modal.clearFunctions(first.owner);
        const after = Modal.confirm('after');
        expect(second.shown).toHaveLength(2);
        Modal.resolveConfirm(second.shown[1].id, true);
        expect(await after).toBe(true);
        Modal.resolveConfirm(second.shown[0].id, false);
        expect(await gap).toBe(false);
    });

    it('#336: a StrictMode-style unregister+re-register in one tick keeps open dialogs alive', async () => {
        const prov = fakeProvider();
        Modal.setFunctions(prov.owner, prov.show, prov.hide, prov.hideAll);
        const p = Modal.confirm('still here');
        Modal.clearFunctions(prov.owner);
        Modal.setFunctions(prov.owner, prov.show, prov.hide, prov.hideAll);
        expect(await settled(p)).toBe('pending');
        Modal.resolveConfirm(prov.shown[0].id, true);
        expect(await p).toBe(true);
    });

    it('#336: a DIFFERENT provider registering in the same tick still settles the old owner\'s dialogs', async () => {
        // Reviewer: A has a pending confirm; A unregisters and a distinct B
        // registers synchronously. B shows nothing for it, yet A's promise and
        // resolver used to stay alive forever.
        const a = fakeProvider();
        Modal.setFunctions(a.owner, a.show, a.hide, a.hideAll);
        const pending = Modal.confirm('A pending');
        Modal.clearFunctions(a.owner);
        const b = fakeProvider();
        Modal.setFunctions(b.owner, b.show, b.hide, b.hideAll);
        expect(b.shown).toHaveLength(0);
        expect(await pending).toBe(false);
        expect(Modal.pendingCount()).toBe(0);
        // B is fully functional afterwards.
        const next = Modal.confirm('B');
        expect(b.shown).toHaveLength(1);
        Modal.resolveConfirm(b.shown[0].id, true);
        expect(await next).toBe(true);
    });

    it('#176: the iOS native prompt resolves an erased field as "" and only Cancel as null', async () => {
        platform.OS = 'ios';
        alertMock.prompt.mockReset();
        const a = Modal.prompt('Limit');
        let buttons = alertMock.prompt.mock.calls[0][2] as Array<{ onPress: (t?: string) => void }>;
        buttons[1].onPress('');
        expect(await a).toBe('');

        const b = Modal.prompt('Limit');
        buttons = alertMock.prompt.mock.calls[1][2] as Array<{ onPress: (t?: string) => void }>;
        buttons[0].onPress();
        expect(await b).toBeNull();

        const c = Modal.prompt('Limit');
        buttons = alertMock.prompt.mock.calls[2][2] as Array<{ onPress: (t?: string) => void }>;
        buttons[1].onPress('12');
        expect(await c).toBe('12');
    });
});
