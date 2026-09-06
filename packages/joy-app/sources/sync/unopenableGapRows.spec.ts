import { describe, it, expect } from 'vitest';
import type { Message } from './typesMessage';
import { projectUnopenableGapRows } from './unopenableGapRows';

const text = (seq: number): Message => ({ kind: 'agent-text', id: `m${seq}`, seq, localId: null, createdAt: 1000 + seq, text: `t${seq}` });

describe('projectUnopenableGapRows (#128 d)', () => {
    it('inserts one placeholder per span where the missing rows begin, newest-first', () => {
        const messages = [text(12), text(11), text(3), text(2)];
        const out = projectUnopenableGapRows(messages, [{ fromSeq: 3, toSeq: 10, count: 4 }]);
        expect(out.map((m) => m.kind === 'unopenable-gap' ? `gap(${m.count})` : m.id)).toEqual(['m12', 'm11', 'gap(4)', 'm3', 'm2']);
        const gap = out[2];
        expect(gap.kind === 'unopenable-gap' && gap.seq).toBe(4);
        expect(messages).toHaveLength(4); // the stored history is untouched
    });

    it('a row inside the span that did open follows the placeholder; several spans keep seq order', () => {
        const messages = [text(30), text(7), text(1)];
        const out = projectUnopenableGapRows(messages, [{ fromSeq: 3, toSeq: 10, count: 6 }, { fromSeq: 20, toSeq: 25, count: 2 }]);
        expect(out.map((m) => m.kind === 'unopenable-gap' ? `gap(${m.count})` : m.id)).toEqual(['m30', 'gap(2)', 'm7', 'gap(6)', 'm1']);
    });

    it('with no spans the stored array is returned as is', () => {
        const messages = [text(2), text(1)];
        expect(projectUnopenableGapRows(messages, [])).toBe(messages);
    });
});
