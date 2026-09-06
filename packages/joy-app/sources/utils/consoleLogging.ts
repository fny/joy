/**
 * Console logging bootstrap for React Native
 *
 * Control flow:
 *
 * console.log("msg", obj)
 * │
 * ├─ consoleOutputEnabled = false? (default for prod)
 * │  └─ return immediately ⛔  (zero cost, args untouched)
 * │
 * ├─ consoleOutputEnabled = true? (default for dev/preview, or toggled on)
 * │  ├─ call original console method ✅
 * │  ├─ capture to in-app buffer ✅
 * │  └─ send to remote log server (if configured) ✅
 * │
 * └─ console.error / console.warn (always, regardless of flag)
 *    ├─ call original console method ✅
 *    ├─ capture to in-app buffer ✅
 *    └─ send to remote log server (if configured) ✅
 */

import { log } from '@/log';
import { MAX_APP_LOG_ENTRIES } from '@/log';
import { getLogServerUrl, relayScopedMMKV } from '@/sync/serverConfig';
import { loadAppConfig } from '@/sync/appConfig';
import { Platform } from 'react-native';
import { serializeForLogs } from '@/utils/truncateForLogs';
import { resolveConsoleOutputEnabled } from '@/utils/consoleOutputSetting';
import { createLogUploader, type LogUploader } from '@/utils/logUploader';

let logBuffer: any[] = []
const MAX_BUFFER_SIZE = MAX_APP_LOG_ENTRIES
let isConsolePatched = false
let remoteLogServerUrl: string | null = null
let consoleOutputEnabled = false
// Bounded, abortable remote uploads (#426) — see logUploader.ts.
let uploader: LogUploader | null = null
let originalConsole: {
  log: typeof console.log,
  info: typeof console.info,
  warn: typeof console.warn,
  error: typeof console.error,
  debug: typeof console.debug,
} | null = null

/**
 * Toggle console output at runtime (e.g. from Dev screen toggle).
 */
export function setConsoleOutputEnabled(enabled: boolean) {
  consoleOutputEnabled = enabled
  // Turning output off must not leave a backlog of uploads draining in the
  // background (#426): drop what is queued and abort what is in flight.
  if (!enabled) uploader?.cancelAll()
}

export function initConsoleLogging() {
  if (isConsolePatched) {
    return
  }

  remoteLogServerUrl = getLogServerUrl();

  // Determine initial state: EXPLICIT user setting > build variant default >
  // off. The raw blob is read so an explicit `false` is distinguishable from
  // an unset preference (#425).
  try {
    const raw = relayScopedMMKV().getString('local-settings');
    const config = loadAppConfig();
    consoleOutputEnabled = resolveConsoleOutputEnabled(raw, config.consoleLoggingDefault);
  } catch {
    consoleOutputEnabled = false;
  }

  originalConsole = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  }

  log.setConsoleCaptureEnabled(true)

  function formatArgs(args: any[]): string {
    return args.map(a => {
      if (a === null || a === undefined) return String(a)
      if (typeof a !== 'object') return serializeForLogs(a)
      try { return serializeForLogs(a) } catch { return String(a) }
    }).join(' ')
  }

  if (remoteLogServerUrl) {
    const url = remoteLogServerUrl + '/logs'
    uploader = createLogUploader({
      send: (body, signal) => fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal,
      }),
    })
  }

  function sendLog(level: string, formatted: string) {
    if (!uploader) {
      return
    }

    uploader.enqueue(JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      message: formatted,
      source: 'mobile',
      platform: Platform.OS,
    }))
  }

  // Patch console methods
  ;(['log', 'info', 'warn', 'error', 'debug'] as const).forEach(level => {
    const alwaysPassThrough = level === 'error' || level === 'warn'

    console[level] = (...args: any[]) => {
      // Full short-circuit: when off, skip everything for log/info/debug
      if (!consoleOutputEnabled && !alwaysPassThrough) {
        return
      }

      // Pass raw args to native console (preserves interactive object inspection,
      // clickable stack traces, and multi-arg formatting in dev tools)
      originalConsole![level](...args)

      // Serialize once for buffer + remote (but NOT for native console)
      const formatted = formatArgs(args)
      log.captureFormatted(level, formatted)

      logBuffer.push({
        timestamp: new Date().toISOString(),
        level,
        message: formatted
      })
      if (logBuffer.length > MAX_BUFFER_SIZE) {
        logBuffer.shift()
      }

      sendLog(level, formatted)
    }
  })

  isConsolePatched = true

  originalConsole.log('[ConsoleLogging] Initialized', consoleOutputEnabled ? '(output enabled)' : '(output suppressed)')
}

// For developer settings UI
export function getLogBuffer() {
  return [...logBuffer]
}

export function clearLogBuffer() {
  logBuffer = []
}
