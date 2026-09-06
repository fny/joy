// Codex thread discovery for "continue": resolve the NEWEST codex thread that
// ran in a given cwd by scanning the rollout files codex writes under
// $CODEX_HOME/sessions/<y>/<m>/<d>/rollout-*.jsonl. Each rollout's first line
// is a session_meta payload carrying {cwd, id} — id IS the thread id that
// thread/resume accepts. Newest-mtime-first, capped so a huge history can't
// stall session creation.

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { codexHome as resolveCodexHome, codexSessionsDir as sessionsDirUnder } from "./codexHome";

const SCAN_CAP = 200;

/** The rollout store — the shared resolver (#524 #541 #546) unless a home is given. */
export function codexSessionsDir(codexHome?: string): string {
  return sessionsDirUnder(codexHome ?? resolveCodexHome());
}

/** The newest thread id whose rollout ran in `cwd`, or null. */
export function findLatestCodexThreadForCwd(cwd: string, codexHome?: string): string | null {
  const files: { path: string; mtimeMs: number }[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        const st = statSync(p);
        if (st.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (st.isFile() && /^rollout-.*\.jsonl$/.test(e)) files.push({ path: p, mtimeMs: st.mtimeMs });
      } catch { /* skip */ }
    }
  };
  walk(codexSessionsDir(codexHome), 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const f of files.slice(0, SCAN_CAP)) {
    try {
      const firstLine = readFileSync(f.path, "utf8").split("\n", 1)[0];
      const meta = JSON.parse(firstLine) as { payload?: { cwd?: string; id?: string } };
      const p = meta.payload ?? (meta as { cwd?: string; id?: string });
      if (p.cwd === cwd && typeof p.id === "string" && p.id) return p.id;
    } catch { /* unreadable rollout — skip */ }
  }
  return null;
}

/** Parse a user-supplied codex config-override string ("key=value key2=value2",
 *  the -c form) into a config map. Values may be quoted to contain spaces. */
export function parseCodexConfigArgs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w.\-]+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
