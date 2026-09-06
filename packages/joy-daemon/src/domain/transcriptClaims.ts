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
// Every claim carries a generation token (monotonic across the process) and
// `held()`, so a holder can tell after an await whether the reservation it
// took is still the one on record before it removes or restores anything.

export type TranscriptClaimMode = "bind" | "replace";

export interface TranscriptClaim {
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
let nextGen = 0;

/** Reserve `path`. Returns null when the reservation conflicts: a replace
 *  conflicts with any live claim, a bind with a live replace. */
export function claimTranscript(path: string, holder: string, mode: TranscriptClaimMode): TranscriptClaim | null {
  const set = live.get(path) ?? new Set<TranscriptClaim>();
  for (const c of set) if (mode === "replace" || c.mode === "replace") return null;
  const gen = ++nextGen;
  const claim: TranscriptClaim = {
    path, holder, mode, gen,
    held: () => set.has(claim),
    release: () => {
      set.delete(claim);
      if (set.size === 0 && live.get(path) === set) live.delete(path);
    },
  };
  set.add(claim);
  live.set(path, set);
  return claim;
}

/** Every live claim on `path` (empty when nobody has reserved it). */
export function transcriptClaims(path: string): readonly TranscriptClaim[] {
  return [...(live.get(path) ?? [])];
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
}
