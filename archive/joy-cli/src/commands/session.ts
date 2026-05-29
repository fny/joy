import { randomUUID } from 'node:crypto';
import { hostname, homedir, platform } from 'node:os';
import { join } from 'node:path';
import { ControlClient } from '../control/client';
import { ensureDaemon, findAgentBin } from '../ensureDaemon';
import { loadHappySessionKey } from 'joy-daemon/src/relay/credentials';
import type {
    AttachInputResult,
    SessionStartResult,
    ProjectionGetResult,
} from 'joy-daemon/src/control/protocol';

async function withClient<T>(fn: (c: ControlClient) => Promise<T>): Promise<T> {
    await ensureDaemon();
    const c = new ControlClient();
    await c.connect();
    try {
        return await fn(c);
    } finally {
        c.close();
    }
}

export async function sessionList(): Promise<void> {
    await withClient(async (c) => {
        const r = await c.request<{ sessions: string[] }>('session.list');
        for (const s of r.sessions) process.stdout.write(s + '\n');
    });
}

export interface StartOpts {
    sessionId?: string;
    sessionKeyB64?: string;
    variant?: 'legacy' | 'dataKey';
    agentBin?: string;
    cwd?: string;
}

export async function sessionStart(opts: StartOpts = {}): Promise<void> {
    const agentBin = opts.agentBin ?? findAgentBin();
    const cwd = opts.cwd ?? process.cwd();
    const agentEnv: Record<string, string> = { JOY_CWD: cwd };

    // Adopt path: caller provided a sessionId. We need a per-session content
    // key — either passed explicitly or pulled from ~/.happy/sessions.json
    // (legacy CLI pairing material).
    if (opts.sessionId) {
        let sessionKeyB64 = opts.sessionKeyB64;
        let variant: 'legacy' | 'dataKey' | undefined = opts.variant;
        if (!sessionKeyB64) {
            const happy = loadHappySessionKey(opts.sessionId);
            if (happy) {
                sessionKeyB64 = happy.sessionKeyB64;
                variant = variant ?? happy.variant;
                process.stderr.write(`joy: using session key from ${happy.source} (variant=${happy.variant})\n`);
            }
        }
        if (!sessionKeyB64 || !variant) {
            throw new Error('joy: --session-id requires --session-key (or a matching entry in ~/.happy/sessions.json)');
        }
        await withClient(async (c) => {
            const r = await c.request<SessionStartResult>('session.start', {
                mode: 'adopt',
                sessionId: opts.sessionId, sessionKeyB64, variant, agentBin, agentEnv,
            });
            process.stdout.write(JSON.stringify(r, null, 2) + '\n');
        });
        return;
    }

    // Create path: daemon registers a brand-new session with the relay
    // using a fresh tag + metadata describing where the agent will run.
    // The metadata shape mirrors happy-cli's Metadata so happy clients
    // (web/mobile) parse and list the session normally.
    const tag = randomUUID();
    const home = homedir();
    const metadata: Record<string, unknown> = {
        path: cwd,
        host: hostname(),
        os: platform(),
        machineId: hostname(),
        homeDir: home,
        happyHomeDir: join(home, '.joy'),
        happyLibDir: join(home, '.joy', 'lib'),
        happyToolsDir: join(home, '.joy', 'tools'),
        name: `joy:${cwd.split('/').pop() || 'session'}`,
        version: '0.0.0',
        startedFromDaemon: true,
    };
    await withClient(async (c) => {
        const r = await c.request<SessionStartResult>('session.start', {
            mode: 'create',
            tag, metadata, agentBin, agentEnv,
        });
        process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    });
}

export async function sessionStop(sessionId: string, reason?: string): Promise<void> {
    await withClient(async (c) => {
        await c.request('session.stop', { sessionId, reason });
    });
}

export async function sessionSend(sessionId: string, text: string): Promise<void> {
    await withClient(async (c) => {
        const event = { type: 'user-message', payload: { messageId: randomUUID(), content: text } };
        const r = await c.request<AttachInputResult>('session.attachInput', { sessionId, event });
        process.stdout.write(`appended ${r.eventId}\n`);
    });
}

export async function sessionCancel(sessionId: string, target?: string): Promise<void> {
    await withClient(async (c) => {
        const event = { type: 'cancel', payload: { targetTurnId: target ?? '*' } };
        const r = await c.request<AttachInputResult>('session.attachInput', { sessionId, event });
        process.stdout.write(`appended ${r.eventId}\n`);
    });
}

export async function sessionSteer(sessionId: string, targetTurnId: string, text: string): Promise<void> {
    await withClient(async (c) => {
        const event = { type: 'steer', payload: { targetTurnId, content: text } };
        const r = await c.request<AttachInputResult>('session.attachInput', { sessionId, event });
        process.stdout.write(`appended ${r.eventId}\n`);
    });
}

export async function sessionProjection(sessionId: string): Promise<void> {
    await withClient(async (c) => {
        const r = await c.request<ProjectionGetResult>('session.projection', { sessionId });
        process.stdout.write(JSON.stringify(r.projection, null, 2) + '\n');
    });
}
