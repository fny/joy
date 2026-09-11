import { describe, it, expect } from "vitest";
import { peerOf } from "./peerMessage";

describe("peerOf", () => {
  it("reads from and from-label off the daemon's wrapper", () => {
    expect(peerOf('<joy-message from="joy:1a2b3c4d" from-label="Claude Code · Greet" reply-to="joy:1a2b3c4d">\nhi\n</joy-message>'))
      .toEqual({ from: "joy:1a2b3c4d", fromLabel: "Claude Code · Greet" });
    expect(peerOf('<joy-message from="cli">\nhi\n</joy-message>')).toEqual({ from: "cli" });
    expect(peerOf('  <joy-message from="cron:nightly" answer="inline">\nx\n</joy-message>')).toEqual({ from: "cron:nightly" });
  });
  it("is empty for the user's own text, or a wrapper with no from", () => {
    expect(peerOf("plain text")).toEqual({});
    expect(peerOf("look at <joy-message from=\"joy:deadbeef\"> mid-text")).toEqual({});
    expect(peerOf("<joy-message>\nno from\n</joy-message>")).toEqual({});
  });
});
