import { describe, it, expect } from 'vitest';
import { pickHomeHeaderStatus } from './homeHeaderStatus';

describe('pickHomeHeaderStatus', () => {
    const oneActive = [{ active: true }];

    it('#222: a lost relay connection is shown even while a cached machine is still marked active', () => {
        expect(pickHomeHeaderStatus('disconnected', oneActive)).toEqual({ kind: 'socket', status: 'disconnected' });
        expect(pickHomeHeaderStatus('connecting', oneActive)).toEqual({ kind: 'socket', status: 'connecting' });
        expect(pickHomeHeaderStatus('error', oneActive)).toEqual({ kind: 'socket', status: 'error' });
    });

    it('shows the machine count only while the relay connection is healthy', () => {
        expect(pickHomeHeaderStatus('connected', [{ active: true }, { active: false }]))
            .toEqual({ kind: 'machines', online: 1, total: 2 });
    });

    it('falls back to the socket status when there are no machines', () => {
        expect(pickHomeHeaderStatus('connected', [])).toEqual({ kind: 'socket', status: 'connected' });
    });
});
