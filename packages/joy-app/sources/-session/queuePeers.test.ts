import { describe, it, expect } from 'vitest';
import { splitPeers, peerBody, peerLabel } from './queuePeers';

describe('queuePeers', () => {
    it('keeps rows with a sender apart from the user\'s own', () => {
        const rows = [
            { id: 'a', text: 'mine', createdAt: 1 },
            { id: 'b', text: '<joy-message from="joy:1a2b3c4d">\nhello\n</joy-message>', createdAt: 2, from: 'joy:1a2b3c4d', fromLabel: 'Claude Code · Greet' },
            { id: 'c', text: '<joy-message from="cli">\nhi\n</joy-message>', createdAt: 3, from: 'cli' },
        ];
        const { own, peers } = splitPeers(rows);
        expect(own.map((r) => r.id)).toEqual(['a']);
        expect(peers.map((r) => r.id)).toEqual(['b', 'c']);
    });
    it('shows the body without the wrapper and names the sender', () => {
        expect(peerBody('<joy-message from="joy:1a2b3c4d" reply-to="joy:1a2b3c4d">\nhello there\n</joy-message>')).toBe('hello there');
        expect(peerBody('plain')).toBe('plain');
        expect(peerLabel({ id: 'b', text: '', createdAt: 0, from: 'joy:1a2b3c4d', fromLabel: 'Claude Code · Greet' })).toBe('Claude Code · Greet (1a2b3c4d)');
        expect(peerLabel({ id: 'c', text: '', createdAt: 0, from: 'cli' })).toBe('cli');
        expect(peerLabel({ id: 'd', text: '', createdAt: 0, from: 'cron:nightly' })).toBe('cron:nightly');
    });
});
