import { describe, expect, it } from 'vitest';
import { stringifyToolCommand } from './toolCommand';

describe('stringifyToolCommand', () => {
    it('returns plain string commands unchanged', () => {
        expect(stringifyToolCommand('ls -la')).toBe('ls -la');
    });

    it('unwraps shell wrapper command arrays', () => {
        expect(stringifyToolCommand(['/bin/zsh', '-lc', 'rg -n "test" .'])).toBe('rg -n "test" .');
        expect(stringifyToolCommand(['bash', '-c', 'pwd'])).toBe('pwd');
    });

    it('joins non-wrapper command arrays', () => {
        expect(stringifyToolCommand(['git', 'status', '--short'])).toBe('git status --short');
    });

    it('returns null for empty or unsupported values', () => {
        expect(stringifyToolCommand('   ')).toBeNull();
        expect(stringifyToolCommand([])).toBeNull();
        expect(stringifyToolCommand(null)).toBeNull();
    });
});

import { shellQuote } from './toolCommand';

describe('stringifyToolCommand — argv boundaries and quoting (#456)', () => {
    it('quotes arguments with spaces or shell metacharacters and keeps empty ones', () => {
        expect(stringifyToolCommand(['printf', '<%s>', 'hello world', ''])).toBe("printf '<%s>' 'hello world' ''");
    });

    it('escapes single quotes inside an argument', () => {
        expect(stringifyToolCommand(['echo', "it's"])).toBe("echo 'it'\\''s'");
    });

    it('does not unwrap a shell -c that carries positional arguments', () => {
        expect(stringifyToolCommand(['bash', '-c', 'echo $1', '_', 'foo'])).toBe("bash -c 'echo $1' _ foo");
    });

    it('still unwraps a bare shell -c script, and keeps the script verbatim', () => {
        expect(stringifyToolCommand(['sh', '-c', 'ls | grep "x y"'])).toBe('ls | grep "x y"');
    });

    it('shellQuote leaves plain words alone', () => {
        expect(shellQuote('--flag=value/path.txt')).toBe('--flag=value/path.txt');
        expect(shellQuote('a b')).toBe("'a b'");
        expect(shellQuote('')).toBe("''");
    });
});
