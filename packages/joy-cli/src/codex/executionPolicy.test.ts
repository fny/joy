import { test, expect } from "vitest";
import { resolveCodexExecutionPolicy } from "./executionPolicy";

// gpt-5.6-sol M2 finding #1: an UNKNOWN permission mode (e.g. a claude mode like
// `auto` accidentally routed to codex) MUST NOT silently grant danger-full-
// access. The mapping fails closed.

test("codex modes map to their intended approval + sandbox", () => {
  expect(resolveCodexExecutionPolicy("default")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  expect(resolveCodexExecutionPolicy("read-only")).toEqual({ approvalPolicy: "on-request", sandbox: "read-only" });
  expect(resolveCodexExecutionPolicy("safe-yolo")).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
  expect(resolveCodexExecutionPolicy("yolo")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
});

test("only the explicit yolo opt-in reaches danger-full-access", () => {
  const dangerous = (m: string | undefined) => resolveCodexExecutionPolicy(m).sandbox === "danger-full-access";
  expect(dangerous("yolo")).toBe(true);
  expect(dangerous("bypassPermissions")).toBe(true);
  // Everything else — including the claude modes that previously escalated —
  // must be confined.
  for (const m of ["auto", "acceptEdits", "plan", "default", "read-only", "safe-yolo", undefined, "", "garbage"] as (string | undefined)[]) {
    expect(dangerous(m)).toBe(false);
  }
});

test("unknown modes fail closed to the least-privileged workable policy", () => {
  expect(resolveCodexExecutionPolicy("auto")).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
  expect(resolveCodexExecutionPolicy(undefined)).toEqual({ approvalPolicy: "on-request", sandbox: "workspace-write" });
});
