// Permission-mode → codex execution policy. Ported from happy-cli's
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

/** Map joy/claude permission-mode strings to codex approval + sandbox.
 *  joy defaults sessions to yolo (never + danger-full-access), matching the
 *  claude `--dangerously-skip-permissions` default. */
export function resolveCodexExecutionPolicy(permissionMode: string | undefined): CodexExecutionPolicy {
  switch (permissionMode) {
    case "read-only": return { approvalPolicy: "never", sandbox: "read-only" };
    case "safe-yolo": return { approvalPolicy: "never", sandbox: "workspace-write" };
    case "acceptEdits": return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "plan": return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "default": return { approvalPolicy: "on-request", sandbox: "workspace-write" };
    case "yolo":
    case "bypassPermissions": return { approvalPolicy: "never", sandbox: "danger-full-access" };
    default: return { approvalPolicy: "never", sandbox: "danger-full-access" }; // yolo default
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
