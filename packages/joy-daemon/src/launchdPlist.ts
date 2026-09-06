// The launchd agent plist `joy install` writes on macOS — a pure function so
// its escaping is testable without running the installer (#500).
//
// Every interpolated value is XML-escaped. PATH is the usual offender: a
// directory such as /Users/A&B/bin put a bare `&` into the document, launchctl
// failed to parse it, and the daemon was never installed. Executable, package
// and log paths can carry the same characters.

import { xmlEscape } from "./domain/quote";

export interface LaunchdPlistValues {
  label: string;
  node: string;
  serverTs: string;
  pkgDir: string;
  path: string;
  relayUrl: string;
  /** The effective Joy home ($JOY_HOME_DIR or ~/.joy) of the installing CLI.
   *  Baked in so the service reads the SAME credentials and state (#499). */
  homeDir: string;
  logFile: string;
}

export function launchdPlist(v: LaunchdPlistValues): string {
  const e = xmlEscape;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${e(v.label)}</string>
  <key>ProgramArguments</key>
  <array><string>${e(v.node)}</string><string>--import</string><string>tsx</string><string>${e(v.serverTs)}</string></array>
  <key>WorkingDirectory</key><string>${e(v.pkgDir)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${e(v.path)}</string><key>JOY_RELAY_URL</key><string>${e(v.relayUrl)}</string><key>JOY_HOME_DIR</key><string>${e(v.homeDir)}</string></dict>
  <key>RunAtLoad</key><true/>
  <!-- KeepAlive=true (restart on ANY exit, incl. clean exit 0) is load-bearing:
       the daemon self-restarts by exiting 0 (see scheduleDaemonRestart). Do not
       narrow to a SuccessfulExit condition or the self-restart would leave it
       dead. launchd relaunches immediately and wins the port over the 1s-delayed
       detached replacement, which then exits via the singleton lock. -->
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${e(v.logFile)}</string>
  <key>StandardErrorPath</key><string>${e(v.logFile)}</string>
</dict>
</plist>
`;
}
