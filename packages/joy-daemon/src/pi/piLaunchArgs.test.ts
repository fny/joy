import { describe, expect, it } from "vitest";
import { PI_READ_ONLY_TOOLS, piLaunchArgs } from "./piSession";

describe("piLaunchArgs", () => {
  it("a fresh session: rpc mode, model, our session id", () => {
    expect(piLaunchArgs({ model: "fireworks/kimi-k3", piSessionId: "abc" })).toEqual(["--mode", "rpc", "--model", "fireworks/kimi-k3", "--session-id", "abc"]);
  });
  it("continue without an id is -c; an id wins over continue", () => {
    expect(piLaunchArgs({ continueLast: true })).toEqual(["--mode", "rpc", "-c"]);
    expect(piLaunchArgs({ continueLast: true, piSessionId: "x" })).toEqual(["--mode", "rpc", "--session-id", "x"]);
  });
  it("effort is --thinking, plan is the read-only tool set, extra args are shell-split and last", () => {
    expect(piLaunchArgs({ effort: "high", permissionMode: "plan", extraArgs: `--name 'my run' --no-skills` })).toEqual([
      "--mode", "rpc", "--thinking", "high", "--tools", PI_READ_ONLY_TOOLS, "--name", "my run", "--no-skills",
    ]);
    expect(piLaunchArgs({ permissionMode: "default" })).toEqual(["--mode", "rpc"]);
  });
  it("malformed extra args throw before anything is spawned", () => {
    expect(() => piLaunchArgs({ extraArgs: "'open" })).toThrow(/unterminated/);
  });
});
