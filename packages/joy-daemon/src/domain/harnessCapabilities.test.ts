import { describe, expect, it } from "vitest";
import { HARNESSES, HARNESS_CAPABILITIES, defaultPermissionModeFor, effortLevelsFor, isHarness, joinExtraArgs, permissionModesFor } from "./harnessCapabilities";
import { splitShellWords } from "./shellWords";
import { shellJoin } from "./quote";
import { parseCodexConfigArgs } from "../codex/codexThreads";

describe("HARNESS_CAPABILITIES", () => {
  it("names every harness, once, under its own key", () => {
    for (const h of HARNESSES) expect(HARNESS_CAPABILITIES[h].harness).toBe(h);
    expect(Object.keys(HARNESS_CAPABILITIES).sort()).toEqual([...HARNESSES].sort());
  });

  it("every harness defaults to its own no-prompts mode (yolo across the board)", () => {
    expect(defaultPermissionModeFor("claude")).toBe("bypassPermissions");
    expect(defaultPermissionModeFor("codex")).toBe("yolo");
    expect(defaultPermissionModeFor("opencode")).toBe("yolo");
    expect(defaultPermissionModeFor("pi")).toBe("default");       // pi's default never asks
    expect(defaultPermissionModeFor("agy")).toBe("bypassPermissions");
  });

  it("a default permission mode is always one of the listed modes", () => {
    for (const h of HARNESSES) {
      const p = HARNESS_CAPABILITIES[h].permissions;
      if (!p) continue;
      expect(p.modes.map((m) => m.key)).toContain(p.default);
      // keys are wire values: no spaces, no case games
      for (const m of p.modes) expect(m.key).toMatch(/^[a-zA-Z-]+$/);
    }
  });

  it("a default effort is one of the fixed levels, and per-model efforts list none", () => {
    for (const h of HARNESSES) {
      const e = HARNESS_CAPABILITIES[h].effort;
      if (!e) continue;
      if (e.default !== null) expect(e.levels).toContain(e.default);
      if (e.perModel && h === "opencode") expect(e.levels).toEqual([]);
    }
  });

  it("the helpers mirror the table", () => {
    expect(permissionModesFor("pi")).toEqual(new Set(["default", "plan"]));
    expect(effortLevelsFor("agy")).toEqual(new Set(["low", "medium", "high"]));
    expect(effortLevelsFor("opencode")).toEqual(new Set());
    expect(isHarness("codex")).toBe(true);
    expect(isHarness("gemini")).toBe(false);
  });

  it("a fixed catalog only for claude; every other harness is live", () => {
    expect(HARNESS_CAPABILITIES.claude.models.source).toBe("static");
    for (const h of HARNESSES) if (h !== "claude") expect(HARNESS_CAPABILITIES[h].models.source).toBe("live");
  });
});

/**
 * `joy new <dir> -- <args>` hands the passthrough argv here. The caller's
 * shell already removed their quoting, so what is joined is bare words —
 * getting the form wrong corrupts arguments without erroring, which is the
 * whole reason this is a function with tests rather than a `.join(" ")`.
 */
describe("joinExtraArgs", () => {
    it("re-quotes for a CLI harness, so shell metacharacters survive the launch line", () => {
        // What the user typed: --allowedTools "Bash(git:*)"
        // What the CLI receives after their shell is done with it:
        const argv = ["--allowedTools", "Bash(git:*)"];
        const joined = joinExtraArgs("claude", argv);
        expect(joined).toBe("'--allowedTools' 'Bash(git:*)'");
        // Bare-joined this would be `--allowedTools Bash(git:*)`, and the
        // launch line dies on the unquoted parens.
        expect(joined).not.toBe(argv.join(" "));
    });

    it("keeps a spaced argument as ONE word", () => {
        expect(joinExtraArgs("claude", ["--system-prompt", "You are terse. No preamble."]))
            .toBe("'--system-prompt' 'You are terse. No preamble.'");
    });

    it("does not let a passthrough argument run a command", () => {
        expect(joinExtraArgs("claude", ["--system-prompt", "cost is $(nproc)"]))
            .toBe("'--system-prompt' 'cost is $(nproc)'");
    });

    it("survives an apostrophe, the case hand-rolled quoting always loses", () => {
        expect(joinExtraArgs("claude", ["--system-prompt", "don't hedge"]))
            .toBe("'--system-prompt' 'don'\\''t hedge'");
    });

    it("round-trips through the daemon's own splitter for pi and agy", () => {
        const argv = ["--flag", "two words", "don't", "Bash(git:*)"];
        for (const harness of ["pi", "agy"] as const) {
            expect(splitShellWords(joinExtraArgs(harness, argv)!)).toEqual(argv);
        }
    });

    it("joins BARE for codex — its parser reads key=value, not a command line", () => {
        const joined = joinExtraArgs("codex", ["model_reasoning_effort=high", "sandbox_mode=workspace-write"]);
        expect(joined).toBe("model_reasoning_effort=high sandbox_mode=workspace-write");
        expect(parseCodexConfigArgs(joined!)).toEqual({
            model_reasoning_effort: "high",
            sandbox_mode: "workspace-write",
        });
    });

    it("shows why codex must NOT be shell-quoted: the value would keep the quote", () => {
        // The bug this function exists to prevent — no error, just a wrong value.
        const wrong = shellJoin(["model_reasoning_effort=high"]);
        expect(parseCodexConfigArgs(wrong)).toEqual({ model_reasoning_effort: "high'" });
    });

    it("refuses a harness that takes none, instead of building a string create would reject", () => {
        expect(joinExtraArgs("opencode", ["--anything"])).toBeNull();
    });

    it("is null for an empty passthrough — `joy new . --` sets nothing", () => {
        for (const harness of ["claude", "codex", "pi", "agy", "opencode"] as const) {
            expect(joinExtraArgs(harness, [])).toBeNull();
        }
    });
});
