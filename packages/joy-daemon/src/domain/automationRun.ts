// What the daemon needs to know about an automation run, as pure functions.
//
// A run is an ordinary headless session — the relay spawns it through the same
// nucleus lane as everything else. Two things make it a run rather than a
// session: the namespaced creation intent that identifies it, and a watchdog
// that turns "this session is waiting for a human" into a FAILURE.
//
// That second part is the whole point of unattended work. A run that stops at
// a login prompt and waits is worse than one that never started: you stop
// thinking about it precisely because it is unattended, so nothing tells you
// it is stuck. It has to be loud, and it has to be loud with a code specific
// enough to act on.

/** Wire constant, shared with the relay (src/automations.mjs). */
export const AUTOMATION_INTENT_PREFIX = "automation-run:";

/** The run id inside a spawn offer's creation intent, or null for an ordinary
 *  spawn. Namespacing the intent is what lets the daemon tell them apart
 *  without a new wire field. */
export function automationRunIdOf(clientIntentId: string | null | undefined): string | null {
  if (typeof clientIntentId !== "string") return null;
  if (!clientIntentId.startsWith(AUTOMATION_INTENT_PREFIX)) return null;
  const id = clientIntentId.slice(AUTOMATION_INTENT_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/** The failure codes a run can end with. Deliberately few, and each one names
 *  something you would do differently about it. */
export type AutomationFailureCode =
  | "blocked:login"       // the agent needs authentication
  | "blocked:trust"       // the folder-trust dialog owns the pane
  | "blocked:permission"  // a permission prompt the no-prompts mode did not cover
  | "agent_died"          // the session went detached
  | "stalled";            // the turn is open but nothing has happened

export interface AutomationFailure {
  code: AutomationFailureCode;
  message: string;
}

/** What the daemon already publishes about a session, in the shape this needs. */
export interface RunWatchView {
  /** joy__login — the agent is asking to be signed in. */
  login?: { message?: string | null } | null;
  /** joy__dialog — a prompt owns the pane. */
  dialog?: { title?: string | null } | null;
  /** joy__codexApproval — an approval request is outstanding. */
  approval?: { title?: string | null } | null;
  /** joy__state — 'detached' means the agent is gone. */
  state?: string | null;
  /** joy__stalled — the turn is open and silent past the budget. */
  stalled?: boolean;
}

/**
 * The folder-trust dialog gets its own code because it is not really a
 * permission question — it is a machine that has never been told this
 * directory is safe, which is fixed once and for all rather than per run.
 * It has silently killed fresh sessions before now.
 */
const TRUST_DIALOG = /\b(trust|do you trust)\b/i;

/**
 * Is this run stopped in a way only a human can clear? Returns the failure, or
 * null while the run is still legitimately working.
 *
 * Order matters: login is checked first because ONE expired sign-in fails
 * every automation on a machine, and reporting that as a generic permission
 * block would scatter a single cause across a dozen unrelated-looking rows.
 */
export function classifyRunFailure(view: RunWatchView): AutomationFailure | null {
  if (view.login) {
    return { code: "blocked:login", message: view.login.message?.trim() || "the agent needs to be signed in" };
  }
  if (view.state === "detached") {
    return { code: "agent_died", message: "the agent exited; the session is detached" };
  }
  const dialogTitle = view.dialog?.title?.trim();
  if (dialogTitle && TRUST_DIALOG.test(dialogTitle)) {
    return { code: "blocked:trust", message: dialogTitle };
  }
  if (view.dialog) {
    return { code: "blocked:permission", message: dialogTitle || "a dialog is waiting in the pane" };
  }
  if (view.approval) {
    return { code: "blocked:permission", message: view.approval.title?.trim() || "an approval is waiting" };
  }
  if (view.stalled) {
    return { code: "stalled", message: "the turn is open but nothing has happened" };
  }
  return null;
}

/** Terminal states a run can be reported in. */
export type AutomationRunState = "running" | "succeeded" | "failed" | "cancelled";
export function isTerminalRunState(state: AutomationRunState): boolean {
  return state !== "running";
}
