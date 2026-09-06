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

  it("containers peel consistently at every nesting; a heading is not a paragraph (#528 residual)", () => {
    // A fence opened inside a quote inside a list item: the quoted line
    // after it is code (markdown-it agrees).
    const listQuote = parseJoyTags('- > ```xml\n  > <joy-title value="example" />\n  > ```');
    expect(listQuote.title).toBeNull();
    expect(listQuote.text).toContain('<joy-title value="example" />');
    // A four-space-indented line after a heading is indented code, not a
    // paragraph continuation — a heading ends no paragraph because it is
    // not one.
    const heading = parseJoyTags('# Header\n    <joy-title value="example" />');
    expect(heading.title).toBeNull();
    expect(heading.text).toBe('# Header\n    <joy-title value="example" />');
    // …and the same after a thematic break, inside a quote, and in a list.
    expect(parseJoyTags('---\n    <joy-title value="example" />').title).toBeNull();
    expect(parseJoyTags('> # Quoted header\n>     <joy-title value="example" />').title).toBeNull();
    expect(parseJoyTags('1. > - ```\n   >   <joy-notify message="deep" />\n   >   ```').notifies).toEqual([]);
    // …whereas a second `- ` is a SIBLING item: it closes the first item and
    // its fence, so a tag in it is live (markdown-it agrees).
    expect(parseJoyTags('1. > - ```\n   > - <joy-notify message="sibling" />').notifies).toEqual([{ headline: "sibling", detail: null }]);
    // A heading's inline span is closed on its line; a real tag after it runs.
    const headingSpan = parseJoyTags('# Use `<joy-title value="x" />` like so\n<joy-title value="Real" />');
    expect(headingSpan.title).toBe("Real");
  });

  it("a fence belongs to its container: an unclosed quote-local fence ends with the blockquote (#528 residual)", () => {
    const r = parseJoyTags('> ```xml\n> example\n\n<joy-title value="live" />');
    expect(r.title).toBe("live");
    expect(r.text).toBe("> ```xml\n> example");
    // The same for a list item: the fence ends when the item does.
    const list = parseJoyTags('- ```\n  <joy-notify message="example" />\n<joy-notify message="live" detail="d" />');
    expect(list.notifies).toEqual([{ headline: "live", detail: "d" }]);
    expect(list.text).toContain('<joy-notify message="example" />');
    // A lazy paragraph continuation keeps the quote (and its paragraph) open.
    const lazy = parseJoyTags('> para `code\n<joy-title value="in span" />` still\n\n<joy-title value="after" />');
    expect(lazy.title).toBe("after");
  });

  it("inline spans match in linear time (#528 residual)", () => {
    const s = "`x` ".repeat(16_000) + '<joy-title value="live" />';
    const t0 = performance.now();
    const r = parseJoyTags(s);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.title).toBe("live");
    // Earliest opener wins: `a``b``c` is ONE span (CommonMark), so the
    // single backticks close each other over the doubles.
    expect(parseJoyTags('`a``b<joy-title value="x" />``c`').title).toBeNull();
  });

  it("a tag nested in another tag's quoted attribute is that value's text, not a second command (#529 regression)", () => {
    const r = parseJoyTags('<joy-notify message="Example <joy-title value=\'hidden\' />" detail="ok" />');
    expect(r.notifies).toEqual([{ headline: "Example <joy-title value='hidden' />", detail: "ok" }]);
    expect(r.title).toBeNull();
    expect(r.text).toBe("");
    // The tag after an accepted one is still found; a malformed opener does
    // not hide a tag inside what would have been its body.
    const two = parseJoyTags('<joy-notify message="m <joy-title value=\'no\' />" /> <joy-title value="yes" />');
    expect(two.notifies).toEqual([{ headline: "m <joy-title value='no' />", detail: null }]);
    expect(two.title).toBe("yes");
    expect(two.text).toBe("");
    const malformed = parseJoyTags('<joy-notify message="open <joy-title value="Closed" />');
    expect(malformed.title).toBe("Closed");
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
