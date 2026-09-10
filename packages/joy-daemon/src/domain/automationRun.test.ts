import { describe, expect, it } from "vitest";
import {
  AUTOMATION_INTENT_PREFIX,
  automationRunIdOf,
  classifyRunFailure,
  isTerminalRunState,
} from "./automationRun";

describe("automationRunIdOf", () => {
  it("reads the run id out of a namespaced intent", () => {
    expect(automationRunIdOf(`${AUTOMATION_INTENT_PREFIX}abc-123`)).toBe("abc-123");
  });

  it("is null for an ordinary spawn, so a normal session is never watched as a run", () => {
    for (const intent of ["local-42", "", null, undefined, "automation-run", "automation-run:"]) {
      expect(automationRunIdOf(intent as string)).toBeNull();
    }
  });
});

describe("classifyRunFailure", () => {
  it("says nothing while the run is legitimately working", () => {
    expect(classifyRunFailure({})).toBeNull();
    expect(classifyRunFailure({ state: "running" })).toBeNull();
  });

  it("login outranks everything — one expired sign-in fails every automation on a machine", () => {
    // Reported as a generic block, a dozen automations would look like a dozen
    // unrelated problems instead of the single one they are.
    const f = classifyRunFailure({ login: { message: "run claude login" }, dialog: { title: "Allow Bash?" } });
    expect(f).toEqual({ code: "blocked:login", message: "run claude login" });
  });

  it("a dead agent is agent_died, not a block", () => {
    expect(classifyRunFailure({ state: "detached" })?.code).toBe("agent_died");
  });

  it("the folder-trust dialog gets its own code — it is fixed once, not per run", () => {
    expect(classifyRunFailure({ dialog: { title: "Do you trust the files in this folder?" } })?.code)
      .toBe("blocked:trust");
    expect(classifyRunFailure({ dialog: { title: "Trust this workspace?" } })?.code).toBe("blocked:trust");
  });

  it("any other dialog or approval is a permission block, and carries its title", () => {
    expect(classifyRunFailure({ dialog: { title: "Allow Bash(rm)?" } }))
      .toEqual({ code: "blocked:permission", message: "Allow Bash(rm)?" });
    expect(classifyRunFailure({ approval: { title: "Apply patch?" } }))
      .toEqual({ code: "blocked:permission", message: "Apply patch?" });
  });

  it("falls back to a usable message when the prompt carries no title", () => {
    expect(classifyRunFailure({ dialog: {} })?.message).toBeTruthy();
    expect(classifyRunFailure({ approval: {} })?.message).toBeTruthy();
    expect(classifyRunFailure({ login: {} })?.message).toBeTruthy();
  });

  it("a stall is a failure, but the last one considered", () => {
    expect(classifyRunFailure({ stalled: true })?.code).toBe("stalled");
    // Anything that explains the stall wins, because that is what to act on.
    expect(classifyRunFailure({ stalled: true, login: {} })?.code).toBe("blocked:login");
    expect(classifyRunFailure({ stalled: true, dialog: { title: "Allow?" } })?.code).toBe("blocked:permission");
  });
});

describe("isTerminalRunState", () => {
  it("only running is not terminal", () => {
    expect(isTerminalRunState("running")).toBe(false);
    for (const s of ["succeeded", "failed", "cancelled"] as const) expect(isTerminalRunState(s)).toBe(true);
  });
});
