// The files a session keeps OUTSIDE its project, in ~/.joy/sessions/<id>/:
// uploads the app sent (uploads/), images the agent showed (media/), handoff
// notes. The app's "Session files" list reads this; opening one goes through
// the ordinary file read, which already allows this directory.
import { readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";

export interface SessionFile { path: string; relativePath: string; name: string; size: number; mtimeMs: number }

const MAX_FILES = 500;
const MAX_DEPTH = 4;

/** Every regular file under `root` (symlinks are never followed), newest
 *  first. A root that does not exist yet is simply empty. */
export function listSessionFiles(root: string): { root: string; files: SessionFile[]; truncated: boolean } {
  const files: SessionFile[] = [];
  let truncated = false;
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH || truncated) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isDirectory()) walk(abs, depth + 1);
      else if (st.isFile()) {
        if (files.length >= MAX_FILES) { truncated = true; return; }
        files.push({ path: abs, relativePath: relative(root, abs), name, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root, 0);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { root, files, truncated };
}
