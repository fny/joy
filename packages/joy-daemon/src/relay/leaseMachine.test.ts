// The lease machine, exhaustively: every (phase, event) pair has exactly one
// answer here. A pair missing from EXPECTED fails the test, so a new event
// or phase cannot be added without deciding it for every row.
import { test, expect } from "vitest";
import { nextLeaseState, LEASE_PHASES, LEASE_EVENT_TYPES, LEASE_TTL_MS, initialLeaseState, isLeaseDeath, reacquireBackoffMs, retryBackoffMs, type LeaseEvent, type LeasePhase, type LeaseState } from "./leaseMachine";

const L = { leaseId: "l1", leaseToken: "t1", epoch: "3" };
const L2 = { leaseId: "l2", leaseToken: "t2", epoch: "4" };
/** The held lease was last renewed at T0; events happen at T. */
const T0 = 1_000_000;
const T = T0 + 5_000;
const EVENTS: Record<string, LeaseEvent> = {
  acquired: { type: "acquired", lease: L2, at: T },
  renew_ok: { type: "renew_ok", at: T },
  "renew_failed(blip)": { type: "renew_failed", error: "renew -> 502", at: T },
  "renew_failed(lapsed)": { type: "renew_failed", error: "The operation was aborted due to timeout", at: T0 + LEASE_TTL_MS },
  "renew_failed(dead)": { type: "renew_failed", error: "renew -> 412 lease_expired", at: T },
  "lease_death(work, expired)": { type: "lease_death", code: "lease_expired", lane: "work" },
  "lease_death(work, superseded)": { type: "lease_death", code: "lease_unknown", lane: "work" },
  "lease_death(control)": { type: "lease_death", code: "lease_epoch_stale", lane: "control" },
  boot_done: { type: "boot_done" },
  stopped: { type: "stopped" },
};

/** Expected answer: the phase (and, when they matter, the lease and effects). */
type Answer = null | { phase: LeasePhase; lease?: string | null; clear?: boolean; backoff?: "retry" | "reacquire" | "control_wait"; bootedOnce?: boolean };
const NEVER: Record<string, Answer> = Object.fromEntries(Object.keys(EVENTS).map((k) => [k, null]));
const STOP: Record<string, Answer> = { stopped: { phase: "stopped", lease: null } };

/** Every phase is tested from two starting states: never booted, and booted once. */
const EXPECTED: Record<LeasePhase, (bootedOnce: boolean) => Record<string, Answer>> = {
  no_lease: (b) => ({ ...NEVER, ...STOP, acquired: { phase: b ? "ready" : "held", lease: "l2" } }),
  lost: (b) => ({ ...NEVER, ...STOP, acquired: { phase: b ? "ready" : "held", lease: "l2" } }),
  held: () => ({
    ...NEVER, ...STOP,
    boot_done: { phase: "ready", bootedOnce: true },
    renew_ok: { phase: "held", lease: "l1" },
    "renew_failed(blip)": { phase: "held", lease: "l1" },
    "renew_failed(lapsed)": { phase: "lost", lease: null, clear: true },
    "renew_failed(dead)": { phase: "lost", lease: null, clear: true },
    "lease_death(work, expired)": { phase: "lost", lease: null, clear: true, backoff: "retry" },
    "lease_death(work, superseded)": { phase: "lost", lease: null, clear: true, backoff: "reacquire" },
    "lease_death(control)": { phase: "held", lease: "l1", backoff: "control_wait" },
    acquired: { phase: "held", lease: "l2" },
  }),
  ready: () => ({
    ...NEVER, ...STOP,
    boot_done: { phase: "ready" },
    renew_ok: { phase: "ready", lease: "l1" },
    "renew_failed(blip)": { phase: "ready", lease: "l1" },
    "renew_failed(lapsed)": { phase: "lost", lease: null, clear: true },
    "renew_failed(dead)": { phase: "lost", lease: null, clear: true },
    "lease_death(work, expired)": { phase: "lost", lease: null, clear: true, backoff: "retry" },
    "lease_death(work, superseded)": { phase: "lost", lease: null, clear: true, backoff: "reacquire" },
    "lease_death(control)": { phase: "ready", lease: "l1", backoff: "control_wait" },
    acquired: { phase: "ready", lease: "l2" },
  }),
  stopped: () => ({ ...NEVER }),
};

const stateFor = (phase: LeasePhase, bootedOnce: boolean): LeaseState => {
  const holding = phase === "held" || phase === "ready";
  return { phase, lease: holding ? L : null, bootedOnce: phase === "ready" ? true : bootedOnce, lostReason: phase === "lost" ? "x" : null, renewedAt: holding ? T0 : null };
};

test("every (phase, event) pair is decided, and decided as the table says", () => {
  expect(new Set(Object.values(EVENTS).map((e) => e.type))).toEqual(new Set(LEASE_EVENT_TYPES));
  expect(Object.values(EVENTS).some((e) => e.type === "lease_death" && e.lane === "control")).toBe(true);
  for (const phase of LEASE_PHASES) {
    for (const bootedOnce of [false, true]) {
      if (phase === "ready" && !bootedOnce) continue; // ready implies booted
      const table = EXPECTED[phase](bootedOnce);
      for (const [name, ev] of Object.entries(EVENTS)) {
        expect(table, `${phase}[bootedOnce=${bootedOnce}] × ${name} is undecided in EXPECTED`).toHaveProperty(name);
        const want = table[name];
        const got = nextLeaseState(stateFor(phase, bootedOnce), ev);
        const label = `${phase}[bootedOnce=${bootedOnce}] × ${name}`;
        if (want === null) { expect(got, label).toBeNull(); continue; }
        expect(got, label).not.toBeNull();
        expect(got!.to.phase, label).toBe(want.phase);
        if (want.lease !== undefined) expect(got!.to.lease?.leaseId ?? null, label).toBe(want.lease);
        expect(!!got!.clearFreshTerminals, label).toBe(!!want.clear);
        expect(got!.backoff, label).toBe(want.backoff);
        if (want.bootedOnce !== undefined) expect(got!.to.bootedOnce, label).toBe(want.bootedOnce);
        // bootedOnce is monotone: no transition ever clears it.
        expect(got!.to.bootedOnce || !stateFor(phase, bootedOnce).bootedOnce, label).toBe(true);
      }
    }
  }
});

test("a lost-and-re-acquired lease is ready through its second boot pass (the code's bootReady never reset)", () => {
  let s = initialLeaseState();
  s = nextLeaseState(s, { type: "acquired", lease: L, at: T0 })!.to;
  expect(s.phase).toBe("held");
  s = nextLeaseState(s, { type: "boot_done" })!.to;
  expect(s.phase).toBe("ready");
  s = nextLeaseState(s, { type: "lease_death", code: "lease_expired", lane: "work" })!.to;
  expect(s).toMatchObject({ phase: "lost", lease: null, lostReason: "lease_expired", bootedOnce: true });
  s = nextLeaseState(s, { type: "acquired", lease: L2, at: T })!.to;
  expect(s).toMatchObject({ phase: "ready", lease: L2 });
});

test("a renew that fails inside the TTL keeps the lease; the TTL runs from the last renew the relay answered", () => {
  let s = nextLeaseState(initialLeaseState(), { type: "acquired", lease: L, at: T0 })!.to;
  // The 2026-10-13 shape: one renew times out through a flaky link.
  s = nextLeaseState(s, { type: "renew_failed", error: "The operation was aborted due to timeout", at: T0 + 13_000 })!.to;
  expect(s).toMatchObject({ phase: "held", lease: L, renewedAt: T0 });
  // The retry a second later lands: the lease is good from when it was sent.
  s = nextLeaseState(s, { type: "renew_ok", at: T0 + 14_000 })!.to;
  expect(s).toMatchObject({ phase: "held", lease: L, renewedAt: T0 + 14_000 });
  s = nextLeaseState(s, { type: "renew_failed", error: "fetch failed", at: T0 + 14_000 + LEASE_TTL_MS - 1 })!.to;
  expect(s.phase).toBe("held");
  s = nextLeaseState(s, { type: "renew_failed", error: "fetch failed", at: T0 + 14_000 + LEASE_TTL_MS })!.to;
  expect(s).toMatchObject({ phase: "lost", lease: null, renewedAt: null });
});

test("a renew answered late never moves the TTL back", () => {
  let s = nextLeaseState(initialLeaseState(), { type: "acquired", lease: L, at: T0 })!.to;
  s = nextLeaseState(s, { type: "renew_ok", at: T0 + 8_000 })!.to;
  s = nextLeaseState(s, { type: "renew_ok", at: T0 + 2_000 })!.to;
  expect(s.renewedAt).toBe(T0 + 8_000);
});

test("lease death is the relay's three codes, wherever they appear in the error text", () => {
  expect(isLeaseDeath(new Error("POST /x -> 401 lease_unknown"))).toBe(true);
  expect(isLeaseDeath("412 lease_epoch_stale")).toBe(true);
  expect(isLeaseDeath(new Error("lease_expired"))).toBe(true);
  expect(isLeaseDeath(new Error("503 relay_busy"))).toBe(false);
});

test("re-acquire backoff is 10–20 s, jittered", () => {
  expect(reacquireBackoffMs(() => 0)).toBe(10_000);
  expect(reacquireBackoffMs(() => 0.999999)).toBe(19_999);
});

test("retry backoff starts at about a second, doubles, and stops at 10 s", () => {
  expect([0, 1, 2, 3, 4, 10].map((n) => retryBackoffMs(n, () => 0))).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000]);
  // Jitter only ever shortens the wait, by up to half.
  expect(retryBackoffMs(0, () => 0.999999)).toBe(501);
  expect(retryBackoffMs(10, () => 0.999999)).toBe(5_001);
});
