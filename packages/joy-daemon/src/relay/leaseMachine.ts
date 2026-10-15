// The lane's lease, as an explicit machine. It used to be two variables in
// nucleusLane.ts — `lease` (null or a Lease) and `bootReady` — and a set of
// rules scattered over the renew loop, the two claim lanes and stop():
//
//   - renew every LEASE_RENEW_MS against the relay's LEASE_TTL_MS;
//   - a failed renew is retried every LEASE_RENEW_RETRY_MS and forgets the
//     lease only once the relay says it is dead, or once the TTL since the
//     last renew that reached it has run out. It used to forget the lease on
//     the FIRST failure — one slow PUT through a flaky link threw away a
//     lease the relay still honoured, and the re-acquire and boot pass that
//     followed held the queue up (2026-10-13: nine leases in an hour).
//     Forgetting clears the fresh-terminal set (whatever posts next does so
//     under a new lease: reconcile, not facts);
//   - lease death (lease_unknown / lease_expired / lease_epoch_stale) forgets
//     the lease the same way — but ONLY when the WORK lane sees it. The
//     control lane never acquires: its long-poll merely raced a rotation by
//     the work lane, and nulling the shared lease there made both lanes
//     re-acquire in a loop (observed live: epoch climbing every few seconds);
//   - a lease that EXPIRED (our renews stopped reaching the relay) is
//     re-acquired at once, with a short backoff that grows only while it
//     keeps failing; a lease that was SUPERSEDED (lease_unknown /
//     lease_epoch_stale: another process acquired this machineId) waits a
//     10–20 s jittered backoff, so two daemons misconfigured onto one
//     machineId thrash slowly and VISIBLY;
//   - `ready` (the outbox may send) = a lease is held AND the boot pass
//     (bindings + content keys) has completed at least once. The flag never
//     resets: a lease lost and re-acquired is `ready` through its second boot
//     pass, because the bindings from the first are still loaded. That is
//     the code's behaviour, kept here as `bootedOnce`.
//
// Same shape as domain/coordinator.ts: one total `nextLeaseState(state, ev)`
// switch, exhaustively tabled in leaseMachine.test.ts. The wiring in
// nucleusLane.ts applies `to` and performs `effects`.

export interface Lease { leaseId: string; leaseToken: string; epoch: string }

export const LEASE_RENEW_MS = 8_000;   // renew cadence
export const LEASE_TTL_MS = 20_000;    // relay-side TTL the cadence must beat
/** Cadence of renew retries while renews are failing. */
export const LEASE_RENEW_RETRY_MS = 1_000;
/** Work-lane backoff before re-acquiring a SUPERSEDED lease: 10 s + up to 10 s. */
export const reacquireBackoffMs = (random: () => number = Math.random): number => 10_000 + Math.floor(random() * 10_000);
/** Backoff for the `attempt`-th consecutive failure (0-based) of the link to
 *  the relay: 1 s, 2 s, 4 s … capped at 10 s, each jittered down by up to
 *  half so a fleet that lost the relay together does not return in step. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 10_000;
export const retryBackoffMs = (attempt: number, random: () => number = Math.random): number => {
  const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt));
  return Math.ceil(ceiling * (1 - random() / 2));
};
/** The control lane's pause when its claim raced a rotation. */
export const CONTROL_LANE_RETRY_MS = 1_000;

export type LeasePhase = "no_lease" | "held" | "ready" | "lost" | "stopped";
export const LEASE_PHASES: readonly LeasePhase[] = ["no_lease", "held", "ready", "lost", "stopped"];

export interface LeaseState {
  phase: LeasePhase;
  lease: Lease | null;
  /** The boot pass completed under some lease of this process. Never resets. */
  bootedOnce: boolean;
  /** Why the last lease was lost (`lost` only). */
  lostReason: string | null;
  /** When the last acquire or renew that the relay answered was SENT. The
   *  relay extended the lease no earlier than that, so it is honoured until
   *  at least renewedAt + LEASE_TTL_MS. Null without a lease. */
  renewedAt: number | null;
}

export type LeaseEvent =
  | { type: "acquired"; lease: Lease; at: number }
  | { type: "renew_ok"; at: number }
  | { type: "renew_failed"; error: string; at: number }
  | { type: "lease_death"; code: string; lane: "work" | "control" }
  | { type: "boot_done" }
  | { type: "stopped" };
export const LEASE_EVENT_TYPES: ReadonlyArray<LeaseEvent["type"]> = ["acquired", "renew_ok", "renew_failed", "lease_death", "boot_done", "stopped"];

export interface LeaseTransition {
  to: LeaseState;
  /** Forget which terminals were posted fresh under the old lease. */
  clearFreshTerminals?: boolean;
  /** How the lane that saw the event waits before its next pass:
   *  `retry` = the short growing backoff (the lease expired), `reacquire` =
   *  10–20 s (it was superseded), `control_wait` = the control lane's pause. */
  backoff?: "retry" | "reacquire" | "control_wait";
}

export const initialLeaseState = (): LeaseState => ({ phase: "no_lease", lease: null, bootedOnce: false, lostReason: null, renewedAt: null });

export const LEASE_DEATH_RE = /lease_unknown|lease_expired|lease_epoch_stale/;
/** A relay answer that says nothing under this lease can resolve anything any more. */
export const isLeaseDeath = (e: unknown): boolean => LEASE_DEATH_RE.test(String(e));
/** Has the TTL since the last answered renew run out at `at`? */
export const leaseLapsed = (s: LeaseState, at: number): boolean => s.renewedAt !== null && at - s.renewedAt >= LEASE_TTL_MS;

/** The one answer for every (state, event) pair, or null = the event is not
 *  meaningful in that state and changes nothing (a renew with no lease, a
 *  boot marker with nothing to boot under). `stopped` answers null to
 *  everything: a stopped lane never leases again. */
export function nextLeaseState(s: LeaseState, ev: LeaseEvent): LeaseTransition | null {
  if (s.phase === "stopped") return null;
  if (ev.type === "stopped") return { to: { ...s, phase: "stopped", lease: null } };
  switch (s.phase) {
    case "no_lease":
    case "lost": switch (ev.type) {
      case "acquired": return { to: { ...s, phase: s.bootedOnce ? "ready" : "held", lease: ev.lease, lostReason: null, renewedAt: ev.at } };
      default: return null;
    }
    case "held": switch (ev.type) {
      case "boot_done": return { to: { ...s, phase: "ready", bootedOnce: true } };
      case "renew_ok": case "renew_failed": case "lease_death": return holding(s, ev);
      case "acquired": return { to: { ...s, lease: ev.lease, renewedAt: ev.at } }; // a re-acquire under a held lease supersedes it
      default: return null;
    }
    case "ready": switch (ev.type) {
      case "boot_done": return { to: s };
      case "renew_ok": case "renew_failed": case "lease_death": return holding(s, ev);
      case "acquired": return { to: { ...s, lease: ev.lease, renewedAt: ev.at } };
      default: return null;
    }
  }
  return null;
}

/** Renew answers and lease deaths, the same for `held` and `ready`. */
function holding(s: LeaseState, ev: Extract<LeaseEvent, { type: "renew_ok" | "renew_failed" | "lease_death" }>): LeaseTransition {
  switch (ev.type) {
    case "renew_ok": return { to: { ...s, renewedAt: Math.max(s.renewedAt ?? ev.at, ev.at) } };
    // Dead only when the relay says so or the TTL has run out; a timeout or
    // a 5xx inside the TTL keeps the lease and the renew loop retries.
    case "renew_failed": return isLeaseDeath(ev.error) || leaseLapsed(s, ev.at) ? lost(s, ev.error) : { to: s };
    case "lease_death":
      if (ev.lane === "control") return { to: s, backoff: "control_wait" };
      return { ...lost(s, ev.code), backoff: ev.code === "lease_expired" ? "retry" : "reacquire" };
  }
}

const lost = (s: LeaseState, reason: string): LeaseTransition => ({ to: { ...s, phase: "lost", lease: null, lostReason: reason, renewedAt: null }, clearFreshTerminals: true });
