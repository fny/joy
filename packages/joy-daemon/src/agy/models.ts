// Antigravity (agy) model catalog. `agy models` prints one DISPLAY NAME per
// line ("Gemini 3.1 Pro (High)", "Claude Opus 4.6 (Thinking)", …) and those
// same strings are what `agy --model` accepts and what settings.json stores
// under "model" — so the display name IS the id. Read once per daemon
// lifetime; the CLI's own auth decides what is listed.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgyModel {
  id: string;          // exactly what `agy --model` takes
  displayName: string;
  isDefault: boolean;
}

export const AGY_SETTINGS_PATH = join(homedir(), ".gemini", "antigravity-cli", "settings.json");

/** The model the CLI itself would pick — settings.json "model", if set. */
export function agyDefaultModelName(): string | null {
  try {
    const s = JSON.parse(readFileSync(AGY_SETTINGS_PATH, "utf8")) as { model?: unknown };
    return typeof s.model === "string" && s.model ? s.model : null;
  } catch { return null; }
}

let memo: Promise<AgyModel[]> | null = null;

export function listAgyModels(): Promise<AgyModel[]> {
  if (memo) return memo;
  memo = new Promise<AgyModel[]>((resolve) => {
    execFile("agy", ["models"], { timeout: 20_000, env: process.env }, (err, stdout) => {
      if (err) { memo = null; resolve([]); return; }
      const def = agyDefaultModelName();
      const names = stdout.split("\n").map((l) => l.trim()).filter((l) => l && !/^usage|^error/i.test(l));
      resolve(names.map((n, i) => ({ id: n, displayName: n, isDefault: def ? n === def : i === 0 })));
    });
  });
  return memo;
}
