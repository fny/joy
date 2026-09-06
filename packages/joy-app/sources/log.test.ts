import { describe, it, expect, afterEach } from 'vitest';
import { errorsToPlain, formatLogValue, log } from './log';

afterEach(() => log.clear());

describe('log — Error values keep their diagnostics (#330)', () => {
    it('captureConsole records name, message and stack of a bare Error', () => {
        log.captureConsole('error', [new Error('connection refused')]);
        const entry = log.getLogs().at(-1)!;
        expect(entry.startsWith('[error] ')).toBe(true);
        expect(entry).toContain('"name": "Error"');
        expect(entry).toContain('"message": "connection refused"');
        expect(entry).toContain('"stack": "Error: connection refused');
        expect(entry).not.toBe('[error] {}');
    });

    it('nested Errors and cause chains are serialized too', () => {
        const root = new TypeError('root cause');
        const wrapped = new Error('outer', { cause: root });
        (wrapped as Error & { code: string }).code = 'ECONNREFUSED';
        const plain = errorsToPlain({ ctx: 'send', err: wrapped, list: [root] }) as any;
        expect(plain.err.message).toBe('outer');
        expect(plain.err.code).toBe('ECONNREFUSED');
        expect(plain.err.cause.name).toBe('TypeError');
        expect(plain.err.cause.message).toBe('root cause');
        expect(plain.list[0].message).toBe('root cause');
        expect(formatLogValue({ err: wrapped })).toContain('root cause');
    });

    it('non-error values are untouched and cycles do not recurse forever', () => {
        expect(formatLogValue('plain')).toBe('plain');
        expect(formatLogValue({ a: 1 })).toBe(JSON.stringify({ a: 1 }, null, 2));
        const cyc: any = { name: 'x' };
        cyc.self = cyc;
        cyc.err = new Error('e');
        expect(() => formatLogValue(cyc)).not.toThrow();
        expect(formatLogValue(cyc)).toContain('[Circular]');
    });
});
