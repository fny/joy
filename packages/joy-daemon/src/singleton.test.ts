import { test, expect } from "vitest";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { acquireSingleton, SingletonError } from "./singleton";

function tmpLock(): string {
  return join(mkdtempSync(join(tmpdir(), "joy-singleton-")), "daemon.lock");
}

test("acquires when no lock exists and writes our pid", () => {
  const lock = tmpLock();
  const release = acquireSingleton(lock);
  expect(existsSync(lock)).toBe(true);
  expect(parseInt(readFileSync(lock, "utf8"), 10)).toBe(process.pid);
  release();
  expect(existsSync(lock)).toBe(false);
});

test("throws SingletonError when a live process holds the lock", () => {
  const lock = tmpLock();
  writeFileSync(lock, "99999");
  expect(() => acquireSingleton(lock, { isAlive: () => true })).toThrow(SingletonError);
  expect(existsSync(lock)).toBe(true); // not removed — the holder keeps it
});

test("reclaims a stale lock left by a dead process", () => {
  const lock = tmpLock();
  writeFileSync(lock, "99999");
  const release = acquireSingleton(lock, { isAlive: () => false });
  expect(parseInt(readFileSync(lock, "utf8"), 10)).toBe(process.pid);
  release();
  expect(existsSync(lock)).toBe(false);
});

test("release() only unlinks the lock if we still hold it", () => {
  const lock = tmpLock();
  const release = acquireSingleton(lock);
  writeFileSync(lock, "12345"); // someone else took it over
  release();
  expect(existsSync(lock)).toBe(true);
  expect(parseInt(readFileSync(lock, "utf8"), 10)).toBe(12345);
});

// ── #589: the lock is never observable half-made, and reclaim never takes a newer owner's ──

test("the lock appears with its full record — never an empty file (#589)", () => {
  const lock = tmpLock();
  const release = acquireSingleton(lock);
  const lines = readFileSync(lock, "utf8").split("\n");
  expect(parseInt(lines[0], 10)).toBe(process.pid); // legacy readers: pid on line 1
  expect(lines[1]).toMatch(/^[0-9a-f]{16}$/);        // per-acquisition nonce
  expect(Number(lines[2])).toBeGreaterThan(0);        // acquisition time
  // no temp file left beside it
  expect(readdirSync(dirname(lock)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  release();
});

test("a fresh empty lock is a creation in progress: occupied, not stale (#589)", () => {
  const lock = tmpLock();
  writeFileSync(lock, ""); // an older daemon between O_EXCL create and write
  expect(() => acquireSingleton(lock, { isAlive: () => false })).toThrow(SingletonError);
  expect(readFileSync(lock, "utf8")).toBe(""); // left alone
  // …but junk older than the creation grace IS stale and gets reclaimed.
  const release = acquireSingleton(lock, { isAlive: () => false, now: () => Date.now() + 60_000 });
  expect(parseInt(readFileSync(lock, "utf8"), 10)).toBe(process.pid);
  release();
});

test("reclaiming a stale lock never unlinks a newer owner that landed meanwhile (#589)", () => {
  const lock = tmpLock();
  const stale = "99999\nstale-nonce\n1\n";
  const fresh = "424242\nfresh-nonce\n2\n";
  writeFileSync(lock, stale);
  const isAlive = (pid: number) => {
    if (pid === 99999) {
      // Between our judgement ("99999 is dead") and our reclaim, another
      // starter reclaimed it first and published ITS lock.
      writeFileSync(lock, fresh);
      return false;
    }
    return pid === 424242;
  };
  expect(() => acquireSingleton(lock, { isAlive })).toThrow(SingletonError);
  // The newer owner's lock is exactly where it was — we did not eat it.
  expect(readFileSync(lock, "utf8")).toBe(fresh);
  expect(readdirSync(dirname(lock)).filter((f) => f.includes(".reclaim.") || f.endsWith(".tmp"))).toEqual([]);
});

test("two starters racing for a free lock: exactly one wins (#589)", () => {
  const lock = tmpLock();
  const release = acquireSingleton(lock);
  // A second acquire in another process would see our live pid; emulate that
  // process by making our own pid read as foreign-and-alive.
  const mine = readFileSync(lock, "utf8");
  writeFileSync(lock, mine.replace(String(process.pid), "31337"));
  expect(() => acquireSingleton(lock, { isAlive: () => true })).toThrow(SingletonError);
  writeFileSync(lock, mine);
  release();
  expect(existsSync(lock)).toBe(false);
});
