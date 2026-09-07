import { readFileSync } from "fs";
import { join } from "path";
import { moduleDir } from "./esm";

/**
 * This daemon's real version, read from its own package.json.
 *
 * It used to be the string literal "joy-daemon/0.1.0", written out in three
 * places, while package.json sat at 1.11.3. A constant is not a version: it
 * carries no information about what is actually installed, and the app's
 * out-of-date check is built on exactly that information.
 *
 * What that cost (#645): the app reads this as `metadata.version` and runs
 * `isVersionSupported(v, MINIMUM_CLI_VERSION)`. `parseVersion` cannot read a
 * `name/x.y.z` string, so it returned null and EVERY daemon read as outdated —
 * and because the string never changed, acknowledging the warning once wrote
 * `acknowledgedCliVersions[machineId] = "joy-daemon/0.1.0"` and suppressed it
 * for good, on that machine, for every version that would ever follow. A
 * daemon three days stale (missing the pane protocol the terminal needs) could
 * not say so, and the terminal simply rendered nothing.
 *
 * Bare semver, so the app parses it directly.
 */
function readVersion(): string {
  // dist/ (published) and src/ (from-source) both sit one level under the
  // package root, so the same relative hop finds package.json either way.
  for (const rel of ["../package.json", "../../package.json"]) {
    try {
      const raw = readFileSync(join(moduleDir(import.meta.url), rel), "utf8");
      const v = JSON.parse(raw)?.version;
      if (typeof v === "string" && v) return v;
    } catch { /* try the next candidate */ }
  }
  // Never invent a number: an unreadable package.json must not claim to be a
  // version the app can compare, or it is the old bug with a new constant.
  return "unknown";
}

export const DAEMON_VERSION = readVersion();

/** `joy-daemon/1.11.3` — for logs and anywhere a human reads it. */
export const DAEMON_VERSION_LABEL = `joy-daemon/${DAEMON_VERSION}`;
