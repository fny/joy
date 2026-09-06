// Transcript-path claims (#550 residual): the in-memory reservation shared by
// every path that takes ownership of a Claude transcript file.
//
// Ownership is visible in two places — a live Session's transcriptPath and a
// window record's launch cwd + Claude id — but both appear only once an
// acquisition has LANDED. create() has tmux awaits between deciding which
// transcript it binds and registering the Session; a teleport import has a
// whole launch between writing the bytes and the session that owns them. A
// claim covers that gap, so a check made against sessions + records + claims
// sees every acquirer, in flight or landed. Two modes:
//   bind    — a launch that reads/tails the file as it is (create with
//             --resume or a pinned fresh id; recovery). Binds coexist: two
//             forks of one live conversation read the same file.
//   replace — a teleport import about to overwrite the file. Exclusive: it
//             is refused while ANY claim is live, and refuses every later
//             bind until released.
// A third shape covers the launch whose file is unknown until Claude picks
// it: a PROJECT claim (claimProject) reserves a whole project dir in bind
// mode. It is refused while an import replaces any transcript in the dir,
// and while it is held an import of ANY transcript in the dir is refused
// (transcriptClaims(path) reports it for every path in the dir). Binds on
// individual files coexist with it, as binds always do.
// Every claim carries a generation token (monotonic across the process) and
// `held()`, so a holder can tell after an await whether the reservation it
// took is still the one on record before it removes or restores anything.

import { dirname } from "path";

export type TranscriptClaimMode = "bind" | "replace";

export interface TranscriptClaim {
  /** The transcript file — or, for a project claim, the project dir. */
  readonly path: string;
  /** Who took it, for diagnostics (`session:<id>`, `teleport-import:<sid>`). */
  readonly holder: string;
  readonly mode: TranscriptClaimMode;
  /** Generation token: strictly increasing across every claim in this process. */
  readonly gen: number;
  /** True while this claim is still on record (taken and not released). */
  held(): boolean;
  release(): void;
}

const live = new Map<string, Set<TranscriptClaim>>();
/** Project-dir reservations (claimProject), keyed by the project dir. */
const liveProjects = new Map<string, Set<TranscriptClaim>>();
let nextGen = 0;

function record(table: Map<string, Set<TranscriptClaim>>, path: string, holder: string, mode: TranscriptClaimMode): TranscriptClaim {
  const set = table.get(path) ?? new Set<TranscriptClaim>();
  const gen = ++nextGen;
  const claim: TranscriptClaim = {
    path, holder, mode, gen,
    held: () => set.has(claim),
    release: () => {
      set.delete(claim);
      if (set.size === 0 && table.get(path) === set) table.delete(path);
    },
  };
  set.add(claim);
  table.set(path, set);
  return claim;
}

/** Reserve `path`. Returns null when the reservation conflicts: a replace
 *  conflicts with any live claim — on the file, or on its project dir — and
 *  a bind with a live replace. */
export function claimTranscript(path: string, holder: string, mode: TranscriptClaimMode): TranscriptClaim | null {
  for (const c of live.get(path) ?? []) if (mode === "replace" || c.mode === "replace") return null;
  if (mode === "replace" && (liveProjects.get(dirname(path))?.size ?? 0) > 0) return null;
  return record(live, path, holder, mode);
}

/** Reserve every transcript in project dir `dir` in bind mode — for a launch
 *  that cannot know its file until Claude picks it (`--continue` in a dir with
 *  no transcript yet). Refused while an import is replacing any transcript in
 *  the dir; while held, an import of any transcript in the dir is refused. */
export function claimProject(dir: string, holder: string): TranscriptClaim | null {
  for (const [path, set] of live) {
    if (dirname(path) !== dir) continue;
    for (const c of set) if (c.mode === "replace") return null;
  }
  return record(liveProjects, dir, holder, "bind");
}

/** Every live claim covering `path`: those on the file itself, then any
 *  project claim on its dir (empty when nobody has reserved it). */
export function transcriptClaims(path: string): readonly TranscriptClaim[] {
  return [...(live.get(path) ?? []), ...(liveProjects.get(dirname(path)) ?? [])];
}

/** Paths with a live claim of `mode` (recovery keeps its hands off a
 *  transcript an import is replacing right now). */
export function claimedTranscriptPaths(mode: TranscriptClaimMode): string[] {
  const out: string[] = [];
  for (const [path, set] of live) if ([...set].some((c) => c.mode === mode)) out.push(path);
  return out;
}

/** Tests only: forget every claim. */
export function resetTranscriptClaims(): void {
  live.clear();
  liveProjects.clear();
}
