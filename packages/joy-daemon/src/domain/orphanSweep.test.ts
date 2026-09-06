// #55 — the orphan tmux sweep retires only per-session servers stamped with
// THIS daemon's identity: another daemon universe on the same box (another
// JOY_HOME_DIR / relay) shares the socket dir and the label scheme, and its
// live sessions are unknown to our records.
import { describe, it, expect } from "vitest";
import { sweepOrphanTmuxServers, parseOwnerStamp, stampTmuxServerOwner, TMUX_OWNER_VAR } from "./orphanSweep";

const OURS = "/home/u/.joy/relays/joy/state";
const THEIRS = "/home/u/.joy-test/relays/joy/state";

/** A fake socket dir: name → { alive, stamp, clients }. */
function world(servers: Record<string, { alive?: boolean; stamp?: string | null; clients?: string }>) {
  const calls: string[][] = [];
  const run = (...args: string[]) => {
    calls.push(args);
    const name = args[2];
    const verb = args[3];
    const s = servers[name];
    if (!s || s.alive === false) return { ok: false, out: "" };
    if (verb === "has-session") return { ok: true, out: "" };
    if (verb === "show-environment") return s.stamp ? { ok: true, out: `${TMUX_OWNER_VAR}=${s.stamp}\n` } : { ok: false, out: `unknown variable: ${TMUX_OWNER_VAR}` };
    if (verb === "list-clients") return { ok: true, out: s.clients ?? "" };
    if (verb === "kill-server") { servers[name] = { ...s, alive: false }; return { ok: true, out: "" }; }
    return { ok: true, out: "" };
  };
  const killed = () => calls.filter((c) => c[3] === "kill-server").map((c) => c[2]);
  return { run, calls, killed, listDir: () => Object.keys(servers) };
}

describe("orphan tmux sweep (#55)", () => {
  it("kills only OUR stamped, recordless, client-less servers", () => {
    const w = world({
      "joy-aaaaaaaa": { stamp: OURS },                       // ours, orphan → swept
      "joy-bbbbbbbb": { stamp: THEIRS },                     // the other daemon's live session → untouched
      "joy-cccccccc": { stamp: null },                       // spawned before the stamp existed → untouched
      "joy-dddddddd": { stamp: OURS },                       // ours but on record → untouched
      "joy-eeeeeeee": { stamp: OURS, clients: "/dev/pts/3" },// a human is attached → untouched
      "joy-ffffffff": { alive: false },                      // dead socket file → skipped
      "joy-relaykey": { stamp: OURS },                       // the shared server → never swept
      "not-ours-12345678": { stamp: OURS },
    });
    const log: string[] = [];
    const killed = sweepOrphanTmuxServers({ dir: "/tmp/tmux-1000", known: new Set(["joy-dddddddd"]), owner: OURS, run: w.run, log: (l) => log.push(l), listDir: w.listDir });
    expect(killed).toEqual(["joy-aaaaaaaa"]);
    expect(w.killed()).toEqual(["joy-aaaaaaaa"]);
    // The foreign and unstamped servers were never even asked for clients.
    expect(w.calls.filter((c) => c[2] === "joy-bbbbbbbb").map((c) => c[3])).toEqual(["has-session", "show-environment"]);
    expect(log.some((l) => l.includes("joy-bbbbbbbb") && l.includes(THEIRS))).toBe(true);
    expect(log.some((l) => l.includes("joy-cccccccc") && l.includes("no owner stamp"))).toBe(true);
    // The shared server and foreign labels are never probed at all.
    expect(w.calls.some((c) => c[2] === "joy-relaykey" || c[2] === "not-ours-12345678")).toBe(false);
  });

  it("the old rule (any recordless server of our label shape) is gone: a foreign universe's server survives our boot", () => {
    const w = world({ "joy-12345678": { stamp: THEIRS } });
    expect(sweepOrphanTmuxServers({ dir: "/x", known: new Set(), owner: OURS, run: w.run, listDir: w.listDir })).toEqual([]);
  });

  it("stamp + parse round-trip", () => {
    const calls: string[][] = [];
    stampTmuxServerOwner({ runSync: (...a: string[]) => { calls.push(a); return { ok: true, out: "" }; } }, OURS);
    expect(calls).toEqual([["set-environment", "-g", TMUX_OWNER_VAR, OURS]]);
    expect(parseOwnerStamp(`${TMUX_OWNER_VAR}=${OURS}\n`)).toBe(OURS);
    expect(parseOwnerStamp(`unknown variable: ${TMUX_OWNER_VAR}`)).toBeNull();
    expect(parseOwnerStamp("")).toBeNull();
  });
});
