import { describe, it, expect } from 'vitest';
import { formatBytes, ageLabel, summarizeSelection, describeNuke } from './storageFormat';

describe('formatBytes', () => {
    it('picks the unit and keeps one decimal only under ten', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(999)).toBe('999 B');
        expect(formatBytes(1536)).toBe('1.5 KB');
        expect(formatBytes(10 * 1024)).toBe('10 KB');
        expect(formatBytes(5.25 * 1024 ** 2)).toBe('5.3 MB');
        expect(formatBytes(79 * 1024 ** 2)).toBe('79 MB');
        expect(formatBytes(2.5 * 1024 ** 3)).toBe('2.5 GB');
    });
    it('shows a dash for nothing', () => {
        expect(formatBytes(null)).toBe('—');
        expect(formatBytes(-1)).toBe('—');
    });
});

describe('ageLabel', () => {
    const now = 1_000_000_000_000;
    it('rounds to whole units', () => {
        expect(ageLabel(now - 20_000, now)).toBe('just now');
        expect(ageLabel(now - 5 * 60_000, now)).toBe('5m ago');
        expect(ageLabel(now - 3 * 3_600_000, now)).toBe('3h ago');
        expect(ageLabel(now - 47 * 3_600_000, now)).toBe('47h ago');
        expect(ageLabel(now - 12 * 86_400_000, now)).toBe('12d ago');
        expect(ageLabel(now - 90 * 86_400_000, now)).toBe('3mo ago');
    });
    it('never goes negative for a clock ahead of ours', () => {
        expect(ageLabel(now + 60_000, now)).toBe('just now');
    });
    it('dashes the unknown', () => {
        expect(ageLabel(null, now)).toBe('—');
    });
});

describe('summarizeSelection + describeNuke', () => {
    const rows = [
        { id: 'a', bytes: 1000, live: false, relayEvents: 10, relayBytes: 500 },
        { id: 'b', bytes: 2000, live: true, relayEvents: 0, relayBytes: 0 },
        { id: 'c', bytes: 4000, live: false },
    ];
    const loose = [
        { id: 't1', bytes: 0, tmux: { alive: true } },
        { id: 't2', bytes: 0, tmux: { alive: false } },
    ];
    it('sums only what is selected, sessions and loose servers apart', () => {
        expect(summarizeSelection(rows, new Set(['a', 'b']))).toEqual({ count: 2, bytes: 3000, relayBytes: 500, relayEvents: 10, live: 1, tmux: 0, tmuxAlive: 0 });
        expect(summarizeSelection([...rows, ...loose], new Set(['t1', 't2']))).toEqual({ count: 0, bytes: 0, relayBytes: 0, relayEvents: 0, live: 0, tmux: 2, tmuxAlive: 1 });
        expect(summarizeSelection(rows, new Set())).toEqual({ count: 0, bytes: 0, relayBytes: 0, relayEvents: 0, live: 0, tmux: 0, tmuxAlive: 0 });
    });
    it('says what goes, and says twice when something is running', () => {
        const s = summarizeSelection(rows, new Set(['a', 'b']));
        expect(describeNuke(s)).toBe('Delete 2 sessions, 2.9 KB on the machine, 10 relay events (500 B). This cannot be undone.\n\n1 session is still running and will be killed first.');
        expect(describeNuke(summarizeSelection(rows, new Set(['c'])))).toBe('Delete 1 session, 3.9 KB on the machine. This cannot be undone.');
    });
    it('names loose tmux servers and warns when one is still up', () => {
        const s = summarizeSelection([...rows, ...loose], new Set(['c', 't1', 't2']));
        expect(describeNuke(s)).toBe('Delete 1 session, 3.9 KB on the machine, 2 loose tmux servers. This cannot be undone.\n\n1 tmux server is still up — whatever runs inside dies with it.');
        expect(describeNuke(summarizeSelection(loose, new Set(['t2'])))).toBe('Delete 1 loose tmux server. This cannot be undone.');
    });
});
