import { describe, expect, it } from 'vitest';
import { buildResumeCommand, buildResumeCommandBlock } from './resumeCommand';

describe('buildResumeCommand', () => {
    it('builds a Claude resume command that enters the session directory first', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toBe(`cd '/tmp/project' && joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd`);
    });

    // #444: PowerShell 5.1 has no `&&`; the invocation is gated on `$?` so a
    // failed Set-Location never starts a resume in the wrong directory.
    it('builds a Windows Codex resume command whose invocation is conditional on the directory change (#444)', () => {
        expect(buildResumeCommand({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'codex',
            codexThreadId: '019ccca5-726b-7c61-b914-16de27dfab6e',
        })).toBe(`Set-Location -LiteralPath 'C:\\Users\\test\\project'; if ($?) { joy new . --resume 019ccca5-726b-7c61-b914-16de27dfab6e }`);
    });

    it('falls back to the bare resume command when no path is available', () => {
        expect(buildResumeCommand({
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toBe('joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd');
    });

    it('returns null when there is no resumable session identifier', () => {
        expect(buildResumeCommand({
            path: '/tmp/project',
            flavor: 'claude',
        })).toBeNull();
    });

    // #229: the info page used to interpolate the live cwd raw; an apostrophe
    // produced an unmatched quote. The shared builder escapes it.
    it('escapes apostrophes in the project path (#229)', () => {
        expect(buildResumeCommand({
            path: "/home/me/John's repo",
            os: 'linux',
            flavor: 'claude',
            claudeSessionId: 'abc',
        })).toBe(`cd '/home/me/John'\\''s repo' && joy new . --resume abc`);
        expect(buildResumeCommand({
            path: "C:\\Users\\John's repo",
            os: 'win32',
            flavor: 'claude',
            claudeSessionId: 'abc',
        })).toBe(`Set-Location -LiteralPath 'C:\\Users\\John''s repo'; if ($?) { joy new . --resume abc }`);
    });

    // #443: the saved path is quoted exactly as recorded; only an
    // all-whitespace path counts as absent.
    it('preserves meaningful trailing characters in the directory (#443)', () => {
        expect(buildResumeCommand({
            path: '/tmp/project ',
            os: 'linux',
            flavor: 'claude',
            claudeSessionId: 'abc',
        })).toBe(`cd '/tmp/project ' && joy new . --resume abc`);
        expect(buildResumeCommand({
            path: '   ',
            os: 'linux',
            flavor: 'claude',
            claudeSessionId: 'abc',
        })).toBe('joy new . --resume abc');
    });
});

describe('buildResumeCommandBlock', () => {
    // #444: the DISPLAY stays two lines, the COPIED text is the conditional
    // one-liner — a pasted block with a plain newline ran the resume after a
    // failed cd.
    it('shows two lines but copies a conditional one-liner when a path is available (#444)', () => {
        expect(buildResumeCommandBlock({
            path: '/tmp/project',
            os: 'darwin',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toEqual({
            lines: [
                `cd '/tmp/project'`,
                'joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd',
            ],
            copyText: `cd '/tmp/project' && joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd`,
        });
    });

    it('falls back to a single-line command block when no path is available', () => {
        expect(buildResumeCommandBlock({
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toEqual({
            lines: ['joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd'],
            copyText: 'joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd',
        });
    });

    it('builds copyable Windows instructions gated on a successful Set-Location (#444)', () => {
        expect(buildResumeCommandBlock({
            path: 'C:\\Users\\test\\project',
            os: 'win32',
            flavor: 'claude',
            claudeSessionId: '93a9705e-bc6a-406d-8dce-8acc014dedbd',
        })).toEqual({
            lines: [
                `Set-Location -LiteralPath 'C:\\Users\\test\\project'`,
                'joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd',
            ],
            copyText: `Set-Location -LiteralPath 'C:\\Users\\test\\project'; if ($?) { joy new . --resume 93a9705e-bc6a-406d-8dce-8acc014dedbd }`,
        });
    });
});
