import { describe, it, expect } from 'vitest';
import { parseSecretsMessage, messageWithSecretsNote, secretsPreview } from './secretsMessage';

describe('parseSecretsMessage', () => {
    it('finds nothing in an ordinary message', () => {
        expect(parseSecretsMessage('log in please')).toBeNull();
        expect(parseSecretsMessage('```ts\nconst a = 1\n```')).toBeNull();
        expect(parseSecretsMessage('see /secrets-page for details')).toBeNull();
    });

    it('takes a fenced block out and keeps the rest', () => {
        const p = parseSecretsMessage('log in to the dashboard with these\n```secrets\nemail: me@x.com\npassword: hunter2\n```\nthanks');
        expect(p).toEqual({ secrets: { email: 'me@x.com', password: 'hunter2' }, rest: 'log in to the dashboard with these\n\nthanks', invalid: [] });
    });

    it('reads a /secrets line, quotes and all', () => {
        const p = parseSecretsMessage('/secrets email=me@x.com password="two words" pin=\'12 34\'\nlog in');
        expect(p).toEqual({ secrets: { email: 'me@x.com', password: 'two words', pin: '12 34' }, rest: 'log in', invalid: [] });
    });

    it('takes /secret as well as /secrets, on any line', () => {
        const p = parseSecretsMessage('log in please\n/secret token=abc');
        expect(p).toEqual({ secrets: { token: 'abc' }, rest: 'log in please', invalid: [] });
    });

    it('leaves a bare /secrets line, and a /secrets path, as ordinary text', () => {
        expect(parseSecretsMessage('/secrets')).toBeNull();
        expect(parseSecretsMessage('/secret\nhello')).toBeNull();
        expect(parseSecretsMessage('/secrets/config.json is missing')).toBeNull();
        expect(parseSecretsMessage('open https://x.com/secrets now')).toBeNull();
        const p = parseSecretsMessage('/secrets\n```secrets\na: 1\n```');
        expect(p).toEqual({ secrets: { a: '1' }, rest: '/secrets', invalid: [] });
    });

    it('keeps a value with colons, equals signs and spaces whole', () => {
        const p = parseSecretsMessage('```secrets\nurl: https://x.com:8080/a?b=c\nphrase = correct horse battery\n```');
        expect(p?.secrets).toEqual({ url: 'https://x.com:8080/a?b=c', phrase: 'correct horse battery' });
        expect(p?.rest).toBe('');
    });

    it('treats an unclosed block as running to the end (typing in progress)', () => {
        const p = parseSecretsMessage('```secrets\nemail: me@x.com\npass');
        expect(p?.secrets).toEqual({ email: 'me@x.com' });
        expect(p?.invalid).toEqual(['pass']);
    });

    it('reports lines it cannot read', () => {
        const p = parseSecretsMessage('```secrets\nno separator here\nbad name: v\n```');
        expect(p?.invalid).toEqual(['no separator here', 'bad name: v']);
        expect(p?.secrets).toEqual({});
    });

    it('merges several blocks; a later duplicate wins', () => {
        const p = parseSecretsMessage('```secrets\na: 1\n```\n/secrets a=2 b=3');
        expect(p?.secrets).toEqual({ a: '2', b: '3' });
    });
});

describe('the note and the preview', () => {
    it('puts the note after the rest, or alone', () => {
        expect(messageWithSecretsNote('log in', ['email', 'password'])).toBe('log in\n\n[secrets saved: email, password — read one with `joy secret get <name>`]');
        expect(messageWithSecretsNote('', ['token'])).toBe('[secrets saved: token — read one with `joy secret get <name>`]');
    });

    it('marks a name that replaces a saved one, without regard to case', () => {
        expect(secretsPreview({ Email: 'x', token: 'y' }, ['email'])).toEqual([{ name: 'Email', replaces: true }, { name: 'token', replaces: false }]);
        expect(secretsPreview({ a: 'x' }, null)).toEqual([{ name: 'a', replaces: false }]);
    });
});
