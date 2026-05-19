/**
 * Minimal structured logger. File-based when JOY_LOG_FILE is set, stderr
 * otherwise. Pretty-prints level/module/msg + JSON ctx.
 */
import { appendFileSync } from 'node:fs';

type Level = 'debug' | 'info' | 'warn' | 'error';

function emit(level: Level, mod: string, msg: string, ctx?: unknown): void {
    const line = JSON.stringify({ t: Date.now(), level, mod, msg, ctx }) + '\n';
    const file = process.env.JOY_LOG_FILE;
    if (file) {
        try {
            appendFileSync(file, line);
            return;
        } catch {
            /* fall through to stderr */
        }
    }
    process.stderr.write(`[${level}] ${mod}: ${msg}${ctx ? ' ' + JSON.stringify(ctx) : ''}\n`);
}

export function logger(mod: string) {
    return {
        debug: (msg: string, ctx?: unknown) => emit('debug', mod, msg, ctx),
        info: (msg: string, ctx?: unknown) => emit('info', mod, msg, ctx),
        warn: (msg: string, ctx?: unknown) => emit('warn', mod, msg, ctx),
        error: (msg: string, ctx?: unknown) => emit('error', mod, msg, ctx),
    };
}
