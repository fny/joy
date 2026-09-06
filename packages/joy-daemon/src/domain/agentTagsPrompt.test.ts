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

  it("a multiline inline span and an indented code block are documentation, not control (#528 residual)", () => {
    const multi = parseJoyTags('`inline\n<joy-title value="example" />\ncode`');
    expect(multi.title).toBeNull();
    expect(multi.text).toBe('`inline\n<joy-title value="example" />\ncode`');
    const indented = parseJoyTags('    <joy-title value="example" />');
    expect(indented.title).toBeNull();
    expect(indented.text).toBe('<joy-title value="example" />');
    // Indented code after a blank line, inside a list item, and a fence
    // nested in a list item / blockquote are all code too.
    const nested = parseJoyTags([
      "Examples:",
      "",
      '    <joy-notify message="Indented" />',
      "",
      "- item",
      "",
      '      <joy-notify message="In list" />',
      "- other",
      "  ```",
      '  <joy-notify message="Nested fence" />',
      "  ```",
      '> ```',
      '> <joy-notify message="Quoted fence" />',
      '> ```',
      '<joy-title value="Real" />',
    ].join("\n"));
    expect(nested.notifies).toEqual([]);
    expect(nested.title).toBe("Real");
    expect(nested.text).toContain('<joy-notify message="Indented" />');
    expect(nested.text).toContain('<joy-notify message="In list" />');
    expect(nested.text).toContain('<joy-notify message="Nested fence" />');
    expect(nested.text).toContain('<joy-notify message="Quoted fence" />');
    expect(nested.text).not.toContain("Real");
  });

  it("an indented line continuing a paragraph is not code; a span never crosses a blank line", () => {
    const lazy = parseJoyTags('Some text\n    <joy-title value="Continued" />');
    expect(lazy.title).toBe("Continued");
    expect(lazy.text).toBe("Some text");
    const broken = parseJoyTags('a `tick\n\n<joy-title value="Open" />\n\nb` end');
    expect(broken.title).toBe("Open");
  });

  it("a `>` inside a quoted attribute does not end the tag (#529 residual)", () => {
    const r = parseJoyTags('<joy-notify message="Tests > baseline" detail="ok" />');
    expect(r.notifies).toEqual([{ headline: "Tests > baseline", detail: "ok" }]);
    expect(r.text).toBe("");
    const t = parseJoyTags('Done.\n<joy-title value="a > b" />\n<joy-notify detail=\'x > y\' message="m" />');
    expect(t.title).toBe("a > b");
    expect(t.notifies).toEqual([{ headline: "m", detail: "x > y" }]);
    expect(t.text).toBe("Done.");
    // An unterminated tag is left alone and does not swallow the next one.
    const open = parseJoyTags('<joy-title value="never closed\n<joy-title value="Closed" />');
    expect(open.title).toBe("Closed");
  });
});
