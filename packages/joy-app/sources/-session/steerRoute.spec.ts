import { describe, it, expect } from 'vitest';
import { steerRoute, commandName } from './steerRoute';

describe('steerRoute', () => {
    it('sends a /steer over the tunnel while the agent is busy', () => {
        expect(steerRoute({ text: '/steer stop and run the tests', busy: true, tunnelAvailable: true })).toBe('tunnel');
        expect(steerRoute({ text: '  /STEER x', busy: true, tunnelAvailable: true })).toBe('tunnel');
    });
    it('keeps the relay when idle, or when the tunnel is down', () => {
        expect(steerRoute({ text: '/steer x', busy: false, tunnelAvailable: true })).toBe('relay');
        expect(steerRoute({ text: '/steer x', busy: true, tunnelAvailable: false })).toBe('relay');
    });
    it('only daemon-intercepted mid-turn commands qualify', () => {
        for (const c of ['btw', 'title', 'login-code', 'joy-prompt']) expect(steerRoute({ text: `/${c} x`, busy: true, tunnelAvailable: true })).toBe('tunnel');
        for (const t of ['/model opus', '/compact', 'plain text', '/steerx nope']) expect(steerRoute({ text: t, busy: true, tunnelAvailable: true })).toBe('relay');
    });
    it('parses the command name', () => {
        expect(commandName('/steer go')).toBe('steer');
        expect(commandName('hello')).toBeNull();
    });
});
