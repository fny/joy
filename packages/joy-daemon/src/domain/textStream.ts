// Chunk-safe text decoding — the one place byte streams become strings
// (review campaign 2026-09, Wave B: #540 #548 #569 #570).
//
// Node hands stream data over in arbitrary chunks. `chunk.toString()` decodes
// each chunk on its own, so a multibyte UTF-8 character whose bytes straddle a
// chunk boundary comes out as replacement characters (€ → ���) — in ripgrep
// and difftastic output (#540), in the opencode HTTP body and SSE feed (#569),
// and in backward transcript reads whose 256 KiB blocks split a character
// (#548). A regex run over a growing string has the sibling problem: it can
// match a value that is still arriving ("…:42" then "123\n" → port 42, #570).
// Every site keeps ONE decoder per stream and reads complete lines only.

import { StringDecoder } from "node:string_decoder";

/** Accumulates a whole stream as text. A trailing partial character is held
 *  back until its remaining bytes arrive (or `end()` flushes it as U+FFFD). */
export class TextAccumulator {
  #dec = new StringDecoder("utf8");
  #text = "";

  /** Decode one chunk; returns the text this chunk completed. */
  push(chunk: Buffer | string): string {
    const s = typeof chunk === "string" ? chunk : this.#dec.write(chunk);
    this.#text += s;
    return s;
  }

  /** Flush any held-back bytes and return everything decoded so far. */
  end(): string {
    this.#text += this.#dec.end();
    return this.#text;
  }

  /** Text decoded so far (a trailing partial character is not yet included). */
  get text(): string { return this.#text; }
}

/** Splits a byte stream into complete lines. A line is only reported once its
 *  "\n" has arrived; a trailing "\r" is dropped so CRLF producers read the same
 *  as LF ones. The partial tail stays buffered across pushes. */
export class LineDecoder {
  #dec = new StringDecoder("utf8");
  #buf = "";

  /** Feed one chunk; returns the lines it completed (without their newline). */
  push(chunk: Buffer | string): string[] {
    this.#buf += typeof chunk === "string" ? chunk : this.#dec.write(chunk);
    const out: string[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      let line = this.#buf.slice(0, nl);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      out.push(line);
      this.#buf = this.#buf.slice(nl + 1);
    }
    return out;
  }

  /** The stream ended: the unterminated tail, or null when there is none. */
  end(): string | null {
    this.#buf += this.#dec.end();
    const rest = this.#buf;
    this.#buf = "";
    return rest.length ? rest : null;
  }

  /** The unterminated text buffered so far. */
  get partial(): string { return this.#buf; }
}

/**
 * Assembles a file that is read BACKWARDS in byte chunks (newest block first).
 * A character split by a block boundary has its continuation bytes at the
 * START of the block already read and its lead byte at the END of the block
 * read next — so continuation bytes at the head are held back (undecoded)
 * until the preceding block is prepended, then decoded together with it.
 */
export class ReverseUtf8Assembler {
  #head: Buffer = Buffer.alloc(0); // leading continuation bytes whose lead byte has not been read yet
  #text = "";

  /** Prepend the block that precedes everything prepended so far. */
  prepend(block: Buffer): void {
    const joined = this.#head.length ? Buffer.concat([block, this.#head]) : block;
    let n = 0;
    while (n < joined.length && n < 3 && (joined[n] & 0xc0) === 0x80) n++;
    this.#head = Buffer.from(joined.subarray(0, n)); // copy — the caller may reuse its buffer
    this.#text = joined.subarray(n).toString("utf8") + this.#text;
  }

  /** The decoded text. While blocks remain unread the first line may still be
   *  partial (a held-back head decodes as U+FFFD); once the file start has been
   *  prepended the text is complete and exact. */
  text(): string {
    return this.#head.length ? this.#head.toString("utf8") + this.#text : this.#text;
  }
}
