// Permission-mode → codex execution policy. Ported from the original CLI harness's
// executionPolicy.ts (the upstream reference) so joy's codex sessions honor the
// same permission vocabulary. Two shapes matter:
//   - thread/start / thread/resume take `sandbox` = a SandboxMode STRING (kebab).
//   - turn/start takes `sandboxPolicy` = a tagged OBJECT.
// Both are produced here.

// The 0.144.6 AskForApproval union (verified against the generated schema —
// gpt-5.6-sol review #7). NOTE: there is NO "on-failure" (that was invalid and
// would be rejected). Object `granular` variant omitted — joy uses the strings.
export type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexExecutionPolicy {
  approvalPolicy: CodexApprovalPolicy;
  sandbox: CodexSandboxMode;
}

// Codex's OWN four permission modes (the app presents these when codex is the
// selected agent — NOT the claude modes). Anything else is treated as unknown.
export type CodexPermissionMode = "default" | "read-only" | "safe-yolo" | "yolo";

/** Map a codex permission-mode string to a codex approval + sandbox policy.
 *
 *  SECURITY (gpt-5.6-sol M2 finding #1): this MUST fail closed. An UNKNOWN mode
 *  string — e.g. a claude mode like `auto` accidentally routed here — must NOT
 *  silently grant `danger-full-access`. Unknown → the collaborative default
 *  (on-request + workspace-write), the least-privileged mode that still lets a
 *  turn make progress. Only the explicit `yolo` opt-in reaches full access. */
export function resolveCodexExecutionPolicy(permissionMode: string | undefined): CodexExecutionPolicy {
  switch (permissionMode) {
    // Collaborative default: the agent asks before running/patching.
    case "default": return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    // Read-only: the agent can read the workspace and asks to escalate.
    case "read-only": return { approvalPolicy: "on-request", sandbox: "read-only" };
    // Safe-yolo: no prompts, but confined to the workspace (no full-disk access).
    case "safe-yolo": return { approvalPolicy: "never", sandbox: "workspace-write" };
    // Yolo: no prompts, full access — the explicit, clearly-labelled opt-in.
    case "yolo":
    case "bypassPermissions": return { approvalPolicy: "never", sandbox: "danger-full-access" };
    // FAIL CLOSED: any other/unknown value (including claude modes like `auto`,
    // `acceptEdits`, `plan`) gets the least-privileged workable policy — never
    // danger-full-access.
    default: return { approvalPolicy: "on-request", sandbox: "workspace-write" };
  }
}

/** The tagged SandboxPolicy object turn/start expects, from a SandboxMode. */
export function sandboxModeToPolicy(mode: CodexSandboxMode): Record<string, unknown> {
  switch (mode) {
    case "read-only": return { type: "readOnly", networkAccess: false };
    case "workspace-write": return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
    case "danger-full-access": return { type: "dangerFullAccess" };
  }
}
