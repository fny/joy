import { test, expect, describe } from "vitest";
import { TextAccumulator, LineDecoder, ReverseUtf8Assembler } from "./textStream";

// € is E2 82 AC — three bytes, the classic split-character probe.
const EURO = Buffer.from("€", "utf8");

describe("TextAccumulator", () => {
  test("a character split across chunks decodes as one character (#540 #569)", () => {
    const acc = new TextAccumulator();
    acc.push(Buffer.concat([Buffer.from("abc"), EURO.subarray(0, 2)]));
    expect(acc.text).toBe("abc"); // the two lead bytes wait
    acc.push(Buffer.concat([EURO.subarray(2), Buffer.from("def")]));
    expect(acc.end()).toBe("abc€def");
  });

  test("end() flushes a truncated trailing character as U+FFFD rather than dropping it", () => {
    const acc = new TextAccumulator();
    acc.push(EURO.subarray(0, 2));
    expect(acc.end()).toBe("�");
  });

  test("string chunks pass through untouched", () => {
    const acc = new TextAccumulator();
    acc.push("x"); acc.push("y");
    expect(acc.end()).toBe("xy");
  });
});

describe("LineDecoder", () => {
  test("a line is reported only once its newline arrives (#570)", () => {
    const ld = new LineDecoder();
    expect(ld.push("listening on http://127.0.0.1:42")).toEqual([]);
    expect(ld.partial).toBe("listening on http://127.0.0.1:42");
    expect(ld.push("123\n")).toEqual(["listening on http://127.0.0.1:42123"]);
    expect(ld.partial).toBe("");
  });

  test("a character split across chunks inside a line survives", () => {
    const ld = new LineDecoder();
    ld.push(Buffer.concat([Buffer.from("a"), EURO.subarray(0, 1)]));
    expect(ld.push(Buffer.concat([EURO.subarray(1), Buffer.from("b\nc\n")]))).toEqual(["a€b", "c"]);
  });

  test("CRLF lines read the same as LF lines; several lines per chunk", () => {
    const ld = new LineDecoder();
    expect(ld.push("one\r\ntwo\nthr")).toEqual(["one", "two"]);
    expect(ld.push("ee\r\n")).toEqual(["three"]);
  });

  test("end() returns the unterminated tail, null when clean", () => {
    const ld = new LineDecoder();
    ld.push("tail");
    expect(ld.end()).toBe("tail");
    expect(ld.end()).toBeNull();
  });
});

describe("ReverseUtf8Assembler", () => {
  test("a character split by the block boundary decodes whole once the earlier block arrives (#548)", () => {
    const bytes = Buffer.from("abc€def", "utf8"); // 3 + 3 + 3 bytes
    const cut = 4; // inside €
    const asm = new ReverseUtf8Assembler();
    asm.prepend(bytes.subarray(cut)); // newest block first: 82 AC 'd' 'e' 'f'
    // Before the earlier block: the two continuation bytes are held back and
    // shown as one U+FFFD each — the first (partial) line, which callers skip.
    expect(asm.text()).toBe("��def");
    asm.prepend(bytes.subarray(0, cut)); // 'a' 'b' 'c' E2
    expect(asm.text()).toBe("abc€def");
  });

  test("blocks with no split character concatenate in file order", () => {
    const asm = new ReverseUtf8Assembler();
    asm.prepend(Buffer.from("world"));
    asm.prepend(Buffer.from("hello "));
    expect(asm.text()).toBe("hello world");
  });

  test("a 4-byte character split three ways is reassembled", () => {
    const bytes = Buffer.from("x🌍y", "utf8"); // 'x' F0 9F 8C 8D 'y'
    const asm = new ReverseUtf8Assembler();
    asm.prepend(bytes.subarray(4)); // 8D 'y'
    asm.prepend(bytes.subarray(2, 4)); // 9F 8C
    asm.prepend(bytes.subarray(0, 2)); // 'x' F0
    expect(asm.text()).toBe("x🌍y");
  });
});
