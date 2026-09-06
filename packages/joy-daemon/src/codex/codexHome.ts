// The Codex home directory — ONE resolver for every path under it (review
// campaign 2026-09, Wave B: #524 #541 #546).
//
// Codex reads and writes its config, sessions and caches under $CODEX_HOME
// when that is set, else ~/.codex. Three daemon sites hard-coded ~/.codex
// (config editing, forks, quota lookup) while two others already honoured the
// variable, so with a custom CODEX_HOME the app edited a config the running
// Codex never read, forks could not find the rollout, and the quota view saw
// no sessions. Resolved at CALL time so tests can retarget the environment.

import { homedir } from "node:os";
import { join } from "node:path";

/** $CODEX_HOME when set to a non-empty value, else `<fallbackHome>/.codex`
 *  (the user's home unless a caller scans an explicit one). */
export function codexHome(fallbackHome: string = homedir()): string {
  const env = process.env.CODEX_HOME;
  if (env && env.trim()) return env;
  return join(fallbackHome, ".codex");
}

/** The rollout store: <codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl. */
export function codexSessionsDir(home: string = codexHome()): string {
  return join(home, "sessions");
}

/** codex's own config file. */
export function codexConfigPath(home: string = codexHome()): string {
  return join(home, "config.toml");
}
