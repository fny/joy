import { describe, it, expect, vi } from 'vitest';
import * as React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { Command } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({ TextInput: () => null }));
const { reported } = vi.hoisted(() => ({ reported: [] as unknown[] }));
vi.mock('@/utils/guardAsync', () => ({
    alertError: () => (e: unknown) => { reported.push(e); },
    guarded: (fn: () => unknown, report: (e: unknown) => void) => () => {
        try {
            const r = fn();
            if (r && typeof (r as Promise<unknown>).then === 'function') (r as Promise<unknown>).then(undefined, report);
        } catch (e) { report(e); }
    },
}));

import { useCommandPalette } from './useCommandPalette';

type Api = ReturnType<typeof useCommandPalette>;

function cmd(id: string, action: Command['action'] = () => {}): Command {
    return { id, title: id, category: 'Test', action };
}

async function renderHook(initial: Command[], onClose: () => void) {
    let api!: Api;
    function Probe({ commands }: { commands: Command[] }) {
        api = useCommandPalette(commands, onClose);
        return null;
    }
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = TestRenderer.create(React.createElement(Probe, { commands: initial })); });
    return {
        get api() { return api; },
        update: async (commands: Command[]) => { await act(async () => { renderer.update(React.createElement(Probe, { commands })); }); },
        unmount: () => renderer.unmount(),
    };
}

describe('useCommandPalette', () => {
    it('#208: shrinking the command list without changing the query pulls the selection back onto a real row', async () => {
        const run = vi.fn();
        const h = await renderHook([cmd('a'), cmd('b'), cmd('c', run)], () => {});
        await act(async () => { h.api.setSelectedIndex(2); });
        expect(h.api.selectedIndex).toBe(2);
        const only = cmd('only', run);
        await h.update([only]);
        expect(h.api.selectedIndex).toBe(0);
        await act(async () => { h.api.handleKeyPress('Enter'); });
        expect(run).toHaveBeenCalledTimes(1);
        h.unmount();
    });

    it('#208: an empty result list parks the cursor at 0 and rows that return are selectable again', async () => {
        const h = await renderHook([cmd('a'), cmd('b')], () => {});
        await act(async () => { h.api.setSelectedIndex(1); });
        await h.update([]);
        expect(h.api.selectedIndex).toBe(0);
        await act(async () => { h.api.handleKeyPress('Enter'); });
        await h.update([cmd('z')]);
        expect(h.api.selectedIndex).toBe(0);
        h.unmount();
    });

    it('#207: a rejecting async command is reported through the guard instead of escaping', async () => {
        reported.length = 0;
        const onClose = vi.fn();
        const h = await renderHook([cmd('boom', async () => { throw new Error('network offline'); })], onClose);
        await act(async () => { h.api.handleSelectCommand(h.api.filteredCategories[0].commands[0]); });
        await Promise.resolve();
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(reported).toHaveLength(1);
        expect((reported[0] as Error).message).toBe('network offline');
        h.unmount();
    });
});
