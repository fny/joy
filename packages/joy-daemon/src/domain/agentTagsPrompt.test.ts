// Daemon-side <joy-title>/<joy-notify> parsing: code is documentation, not
// control (#528); attributes in any order (#529).
import { describe, it, expect } from "vitest";
import { parseJoyTags } from "./agentTagsPrompt";

describe("parseJoyTags", () => {
  it("tags inside fenced or inline code are literal text, not control (#528)", () => {
    const raw = [
      "Use it like this:",
      "```xml",
      '<joy-title value="Example title" />',
      '<joy-notify message="Example push" detail="d" />',
      "```",
      'Inline: `<joy-title value="Inline" />` and ``<joy-notify message="Two ticks" />`` too.',
      '<joy-title value="Real title" />',
      "~~~",
      '<joy-notify message="Tilde fence" />',
      "~~~",
      "Done.",
    ].join("\n");
    const r = parseJoyTags(raw);
    expect(r.title).toBe("Real title");
    expect(r.notifies).toEqual([]);
    expect(r.text).toContain('<joy-title value="Example title" />');
    expect(r.text).toContain('<joy-notify message="Example push" detail="d" />');
    expect(r.text).toContain('`<joy-title value="Inline" />`');
    expect(r.text).toContain('``<joy-notify message="Two ticks" />``');
    expect(r.text).toContain('<joy-notify message="Tilde fence" />');
    expect(r.text).not.toContain("Real title");
    expect(r.text.endsWith("Done.")).toBe(true);
  });

  it("a real tag beside inline code on the same line is still honoured", () => {
    const r = parseJoyTags('Run `make` first. <joy-notify message="Need a decision" />\nThen wait.');
    expect(r.notifies).toEqual([{ headline: "Need a decision", detail: null }]);
    expect(r.text).toBe("Run `make` first.\nThen wait.");
  });

  it("notify attributes parse in any order (#529)", () => {
    const r = parseJoyTags('<joy-notify detail="Build passed" message="Deploy finished" />');
    expect(r.notifies).toEqual([{ headline: "Deploy finished", detail: "Build passed" }]);
    expect(r.text).toBe("");
    const t = parseJoyTags('<joy-title foo="x" value="Title" />');
    expect(t.title).toBe("Title");
  });
});
