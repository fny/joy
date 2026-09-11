// The lane's lease, as an explicit machine. It used to be two variables in
// nucleusLane.ts — `lease` (null or a Lease) and `bootReady` — and a set of
// rules scattered over the renew loop, the two claim lanes and stop():
//
//   - renew every LEASE_RENEW_MS against the relay's LEASE_TTL_MS;
//   - a failed renew forgets the lease AND clears the fresh-terminal set
//     (whatever posts next does so under a new lease: reconcile, not facts);
//   - lease death (lease_unknown / lease_expired / lease_epoch_stale) forgets
//     the lease the same way — but ONLY when the WORK lane sees it. The
//     control lane never acquires: its long-poll merely raced a rotation by
//     the work lane, and nulling the shared lease there made both lanes
//     re-acquire in a loop (observed live: epoch climbing every few seconds);
//   - the work lane re-acquires after a 10–20 s jittered backoff, so two
//     daemons misconfigured onto one machineId thrash slowly and VISIBLY;
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
/** Work-lane backoff before re-acquiring a lost lease: 10 s + up to 10 s. */
export const reacquireBackoffMs = (random: () => number = Math.random): number => 10_000 + Math.floor(random() * 10_000);
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
}

export type LeaseEvent =
  | { type: "acquired"; lease: Lease }
  | { type: "renew_ok" }
  | { type: "renew_failed"; error: string }
  | { type: "lease_death"; code: string; lane: "work" | "control" }
  | { type: "boot_done" }
  | { type: "stopped" };
export const LEASE_EVENT_TYPES: ReadonlyArray<LeaseEvent["type"]> = ["acquired", "renew_ok", "renew_failed", "lease_death", "boot_done", "stopped"];

export interface LeaseTransition {
  to: LeaseState;
  /** Forget which terminals were posted fresh under the old lease. */
  clearFreshTerminals?: boolean;
  /** How the lane that saw the event waits before its next pass. */
  backoff?: "reacquire" | "control_wait";
}

export const initialLeaseState = (): LeaseState => ({ phase: "no_lease", lease: null, bootedOnce: false, lostReason: null });

export const LEASE_DEATH_RE = /lease_unknown|lease_expired|lease_epoch_stale/;
/** A relay answer that says nothing under this lease can resolve anything any more. */
export const isLeaseDeath = (e: unknown): boolean => LEASE_DEATH_RE.test(String(e));

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
      case "acquired": return { to: { ...s, phase: s.bootedOnce ? "ready" : "held", lease: ev.lease, lostReason: null } };
      default: return null;
    }
    case "held": switch (ev.type) {
      case "boot_done": return { to: { ...s, phase: "ready", bootedOnce: true } };
      case "renew_ok": return { to: s };
      case "renew_failed": return lost(s, ev.error);
      case "lease_death": return ev.lane === "work" ? { ...lost(s, ev.code), backoff: "reacquire" } : { to: s, backoff: "control_wait" };
      case "acquired": return { to: { ...s, lease: ev.lease } }; // a re-acquire under a held lease supersedes it
      default: return null;
    }
    case "ready": switch (ev.type) {
      case "boot_done": return { to: s };
      case "renew_ok": return { to: s };
      case "renew_failed": return lost(s, ev.error);
      case "lease_death": return ev.lane === "work" ? { ...lost(s, ev.code), backoff: "reacquire" } : { to: s, backoff: "control_wait" };
      case "acquired": return { to: { ...s, lease: ev.lease } };
      default: return null;
    }
  }
  return null;
}

const lost = (s: LeaseState, reason: string): LeaseTransition => ({ to: { ...s, phase: "lost", lease: null, lostReason: reason }, clearFreshTerminals: true });
