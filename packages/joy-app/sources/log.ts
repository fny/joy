/**
 * Simple logging mechanism that writes to console and maintains internal array
 * Keeps last 5k records in memory with change notifications for UI updates
 */
import { serializeForLogs } from '@/utils/truncateForLogs';

type ConsoleLogLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';
export const MAX_APP_LOG_ENTRIES = 5000;

const ERROR_WALK_MAX_DEPTH = 10;
// Stack traces are long by nature; the default 500-char truncation would
// keep ~2 frames. Values carrying an Error get a roomier budget.
const ERROR_MAX_STRING_LENGTH = 2000;

/**
 * Replace every Error inside `value` (at any depth, including `cause`
 * chains) with a plain object carrying its diagnostic fields.
 *
 * #330: Error's name/message/stack are NON-enumerable, so a generic
 * JSON walk (serializeForLogs) turns `new Error('connection refused')`
 * into `{}` and the in-app log loses the failure reason entirely.
 * Own enumerable extras (code, status, …) are kept as well.
 */
export function errorsToPlain(value: unknown, depth = 0, ancestors: WeakSet<object> = new WeakSet()): unknown {
    if (value === null || typeof value !== 'object') {
        return value;
    }
    if (depth >= ERROR_WALK_MAX_DEPTH) {
        return value instanceof Error ? `${value.name}: ${value.message}` : value;
    }
    // Ancestor set, not a visited set: the same Error legitimately appears
    // twice (as a cause and in a list); only a true cycle is cut.
    if (ancestors.has(value)) {
        return '[Circular]';
    }
    ancestors.add(value);
    try {
        if (value instanceof Error) {
            const plain: Record<string, unknown> = { name: value.name, message: value.message };
            if (value.stack) {
                plain.stack = value.stack;
            }
            for (const [key, extra] of Object.entries(value)) {
                if (!(key in plain)) {
                    plain[key] = errorsToPlain(extra, depth + 1, ancestors);
                }
            }
            const cause = (value as { cause?: unknown }).cause;
            if (cause !== undefined) {
                plain.cause = errorsToPlain(cause, depth + 1, ancestors);
            }
            return plain;
        }
        if (Array.isArray(value)) {
            return value.map((item) => errorsToPlain(item, depth + 1, ancestors));
        }
        const out: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            out[key] = errorsToPlain(item, depth + 1, ancestors);
        }
        return out;
    } finally {
        ancestors.delete(value);
    }
}

function containsError(value: unknown, depth = 0): boolean {
    if (value instanceof Error) {
        return true;
    }
    if (value === null || typeof value !== 'object' || depth >= ERROR_WALK_MAX_DEPTH) {
        return false;
    }
    return Object.values(value as Record<string, unknown>).some((item) => containsError(item, depth + 1));
}

/** Serialize any value for the in-app log, keeping Error diagnostics (#330). */
export function formatLogValue(value: unknown): string {
    if (!containsError(value)) {
        return serializeForLogs(value);
    }
    return serializeForLogs(errorsToPlain(value), ERROR_MAX_STRING_LENGTH);
}

class Logger {
    private logs: string[] = [];
    private maxLogs = MAX_APP_LOG_ENTRIES;
    private listeners: Array<() => void> = [];
    private consoleCaptureEnabled = false;

    private append(message: string): void {
        this.logs.push(message);

        // Maintain 5k limit with circular buffer
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // Notify listeners for real-time updates
        this.listeners.forEach(listener => listener());
    }

    private formatValue(value: unknown): string {
        return formatLogValue(value);
    }

    private formatConsoleMessage(level: ConsoleLogLevel, args: unknown[]): string {
        const message = args.map(arg => this.formatValue(arg)).join('\n');
        if (level === 'log') {
            return message;
        }
        return `[${level}] ${message}`;
    }

    setConsoleCaptureEnabled(enabled: boolean): void {
        this.consoleCaptureEnabled = enabled;
    }

    captureConsole(level: ConsoleLogLevel, args: unknown[]): void {
        this.append(this.formatConsoleMessage(level, args));
    }

    /**
     * Capture a pre-formatted message (avoids double serialization)
     */
    captureFormatted(level: ConsoleLogLevel, formatted: string): void {
        const message = level === 'log' ? formatted : `[${level}] ${formatted}`;
        this.append(message);
    }

    /**
     * Log a message - writes to both console and internal array
     */
    log(message: string): void {
        if (!this.consoleCaptureEnabled) {
            this.append(message);
        }

        console.log(message);
    }

    /**
     * Get all logs as a copy of the array
     */
    getLogs(): string[] {
        return [...this.logs];
    }

    /**
     * Clear all logs
     */
    clear(): void {
        this.logs = [];
        this.listeners.forEach(listener => listener());
    }

    /**
     * Subscribe to log changes - returns unsubscribe function
     */
    onChange(listener: () => void): () => void {
        this.listeners.push(listener);
        return () => {
            const index = this.listeners.indexOf(listener);
            if (index > -1) {
                this.listeners.splice(index, 1);
            }
        };
    }

    /**
     * Get current number of logs
     */
    getCount(): number {
        return this.logs.length;
    }

    getMaxLogs(): number {
        return this.maxLogs;
    }
}

// Export singleton instance
export const log = new Logger();
