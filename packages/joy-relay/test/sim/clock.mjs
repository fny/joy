// The simulation's one clock. Installing it replaces the global Date, which
// is enough to move EVERY clock the relay reads: JavaScript's Date.now(), and
// PGlite's now() too — the embedded postgres asks the host for the time of
// day through emscripten, which answers with Date.now(). So a lease that
// expires "20 seconds from now" expires when this clock says so, not when
// the wall does, and a 5-second sweep interval is a step, not a wait.
//
// Time never moves on its own. It moves when the simulation advances it, and
// by one millisecond per relay request (world.mjs), so no two rows are ever
// stamped with the same instant — a tie the real relay can't produce and the
// sim shouldn't either.
export function installClock(startMs = Date.UTC(2030, 0, 1)) {
  const RealDate = globalThis.Date;
  let now = startMs;
  class SimDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(now);
      else super(...args);
    }
    static now() { return now; }
  }
  globalThis.Date = SimDate;
  return {
    now: () => now,
    advance(ms) { now += ms; return now; },
    set(ms) { now = ms; },
    uninstall() { globalThis.Date = RealDate; },
    isoNow: () => new RealDate(now).toISOString(),
  };
}
